begin;

create or replace function public.claim_source_page_article_inventory_job_v2(p_lease_seconds integer default 240)
returns setof public.source_page_article_inventory_jobs_v1
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare v_id uuid; v_status text; v_token uuid:=gen_random_uuid();
begin
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then
    raise exception 'inventory_v2_freeze_stale';
  end if;
  select id,status into v_id,v_status
  from public.source_page_article_inventory_jobs_v1
  where (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now()))
    and attempt_count<4
  order by requires_third_pass desc,created_at
  for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.source_page_article_inventory_jobs_v1
     set status='running',lease_token=v_token,
         lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),
         attempt_count=attempt_count+case when v_status='running' then 1 else 0 end,
         error_message=null,updated_at=now()
   where id=v_id;
  return query select * from public.source_page_article_inventory_jobs_v1 where id=v_id;
end
$function$;

create or replace function public.yield_source_page_article_inventory_job_v2(p_job_id uuid,p_lease_token uuid,p_stage text)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'inventory_v2_yield_lease_invalid';
  end if;
  update public.source_page_article_inventory_jobs_v1
     set status='queued',lease_token=null,lease_expires_at=null,
         error_message=null,updated_at=now()
   where id=p_job_id;
  return jsonb_build_object('status','queued','completed_stage',left(coalesce(p_stage,''),200),'attempt_count',j.attempt_count);
end
$function$;

create or replace function public.fail_source_page_article_inventory_job_v2(
  p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_message text:=coalesce(p_error_message,'inventory worker failed');
  v_structural boolean;
  v_failures integer;
  v_next text;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then
    raise exception 'inventory_v2_fail_lease_invalid';
  end if;
  v_structural := v_message ~* '(groups array is missing|group is not an object|invalid group_kind|empty block_indices|unknown block index|assigned more than once|headline_anchor|non_article_role|block partition incomplete|mappings array missing|mapping row count mismatch|mapping row is not an object|invalid or duplicate group mapping|invalid or duplicate article mapping|mapping is not bijective|exhausted repair attempt)';
  v_failures:=j.attempt_count+1;
  v_next:=case when v_structural then 'needs_review' when coalesce(p_retryable,true) and v_failures<4 then 'queued' else 'failed' end;
  update public.source_page_article_inventory_jobs_v1
     set status=v_next,attempt_count=v_failures,lease_token=null,lease_expires_at=null,
         error_message=left(v_message,4000),updated_at=now(),
         finished_at=case when v_next='failed' then now() else null end
   where id=p_job_id;
  return jsonb_build_object('status',v_next,'attempt_count',v_failures,'retry_scheduled',(v_next='queued'),'structural_failure',v_structural);
end
$function$;

revoke all on function public.claim_source_page_article_inventory_job_v2(integer) from public,anon,authenticated;
revoke all on function public.yield_source_page_article_inventory_job_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.fail_source_page_article_inventory_job_v2(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_source_page_article_inventory_job_v2(integer) to service_role;
grant execute on function public.yield_source_page_article_inventory_job_v2(uuid,uuid,text) to service_role;
grant execute on function public.fail_source_page_article_inventory_job_v2(uuid,uuid,text,boolean) to service_role;

revoke execute on function public.claim_source_page_article_inventory_job_v1(integer) from service_role;
revoke execute on function public.fail_source_page_article_inventory_job_v1(uuid,uuid,text,boolean) from service_role;

commit;
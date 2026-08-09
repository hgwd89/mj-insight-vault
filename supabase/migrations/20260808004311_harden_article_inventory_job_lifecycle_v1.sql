begin;

create or replace function public.renew_source_page_article_inventory_job_lease_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 420
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'inventory_v1_lease_invalid';
  end if;
  update public.source_page_article_inventory_jobs_v1
     set lease_expires_at=now()+make_interval(secs=>greatest(180,least(900,coalesce(p_lease_seconds,420)))),
         updated_at=now()
   where id=p_job_id;
  return jsonb_build_object('status','running','lease_expires_at',(select lease_expires_at from public.source_page_article_inventory_jobs_v1 where id=p_job_id));
end
$function$;

create or replace function public.fail_source_page_article_inventory_job_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_message text,
  p_retryable boolean default true
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype; v_next text;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then
    raise exception 'inventory_v1_fail_lease_invalid';
  end if;
  v_next:=case when coalesce(p_retryable,true) and j.attempt_count<4 then 'queued' else 'failed' end;
  update public.source_page_article_inventory_jobs_v1
     set status=v_next,
         lease_token=null,
         lease_expires_at=null,
         error_message=left(coalesce(p_error_message,'inventory worker failed'),4000),
         updated_at=now(),
         finished_at=case when v_next='failed' then now() else null end
   where id=p_job_id;
  return jsonb_build_object('status',v_next,'attempt_count',j.attempt_count,'retry_scheduled',(v_next='queued'));
end
$function$;

create or replace function public.requeue_source_page_article_inventory_job_v1(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then
    raise exception 'inventory_v1_freeze_stale';
  end if;
  update public.source_page_article_inventory_jobs_v1
     set status='queued', lease_token=null, lease_expires_at=null, error_message=null,
         finished_at=null, updated_at=now()
   where id=p_job_id and status in ('failed','needs_review');
  if not found then raise exception 'inventory_v1_requeue_not_allowed'; end if;
  return jsonb_build_object('status','queued');
end
$function$;

revoke all on function public.renew_source_page_article_inventory_job_lease_v1(uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.fail_source_page_article_inventory_job_v1(uuid,uuid,text,boolean) from public, anon, authenticated;
revoke all on function public.requeue_source_page_article_inventory_job_v1(uuid) from public, anon, authenticated;
grant execute on function public.renew_source_page_article_inventory_job_lease_v1(uuid,uuid,integer) to service_role;
grant execute on function public.fail_source_page_article_inventory_job_v1(uuid,uuid,text,boolean) to service_role;
grant execute on function public.requeue_source_page_article_inventory_job_v1(uuid) to service_role;

commit;
begin;

create or replace function public.claim_source_page_article_inventory_job_v3(
  p_job_id uuid default null,
  p_lease_seconds integer default 240
) returns setof public.source_page_article_inventory_jobs_v1
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_id uuid;
  v_status text;
  v_token uuid:=gen_random_uuid();
begin
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then
    raise exception 'inventory_v3_freeze_stale';
  end if;

  if p_job_id is null then
    select id,status into v_id,v_status
      from public.source_page_article_inventory_jobs_v1
     where (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now()))
       and attempt_count<4
     order by requires_third_pass desc,created_at
     for update skip locked
     limit 1;
  else
    select id,status into v_id,v_status
      from public.source_page_article_inventory_jobs_v1
     where id=p_job_id
       and (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now()))
       and attempt_count<4
     for update skip locked;
  end if;

  if v_id is null then return; end if;

  update public.source_page_article_inventory_jobs_v1
     set status='running',
         lease_token=v_token,
         lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),
         attempt_count=attempt_count+case when v_status='running' then 1 else 0 end,
         error_message=null,
         updated_at=now()
   where id=v_id;

  return query select * from public.source_page_article_inventory_jobs_v1 where id=v_id;
end
$function$;

revoke all on function public.claim_source_page_article_inventory_job_v3(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_source_page_article_inventory_job_v3(uuid,integer) to service_role;

commit;

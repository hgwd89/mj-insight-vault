begin;

create or replace function public.claim_strict_chat_job_v17(p_job_id uuid,p_lease_seconds integer default 270)
returns setof public.chat_jobs
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare j public.chat_jobs%rowtype;v_token uuid:=gen_random_uuid();
begin
  select * into j from public.chat_jobs where id=p_job_id for update;
  if not found then return; end if;
  if j.status in ('completed','failed','needs_review','cancelled') then return; end if;
  if j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)>=now() then return; end if;
  update public.chat_jobs
     set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,270)))),
         attempt_count=attempt_count+case when j.status='running' then 1 else 0 end,error_message=null,updated_at=now(),started_at=coalesce(started_at,now())
   where id=p_job_id;
  return query select * from public.chat_jobs where id=p_job_id;
end
$function$;

create or replace function public.yield_strict_chat_job_v17(
  p_job_id uuid,p_lease_token uuid,p_status text,p_result_json jsonb,p_error_message text default null,p_report_id uuid default null
) returns public.chat_jobs
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare j public.chat_jobs%rowtype;
begin
  select * into j from public.chat_jobs where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'strict_chat_job_v17_lease_invalid'; end if;
  if p_status not in ('running','completed','needs_review','failed') then raise exception 'strict_chat_job_v17_status_invalid'; end if;
  update public.chat_jobs set status=p_status,result_json=coalesce(p_result_json,'{}'::jsonb),error_message=nullif(left(coalesce(p_error_message,''),4000),''),report_id=coalesce(p_report_id,report_id),
    lease_token=null,lease_expires_at=null,finished_at=case when p_status in ('completed','failed') then now() else null end,updated_at=now()
  where id=p_job_id returning * into j;
  return j;
end
$function$;

revoke all on function public.claim_strict_chat_job_v17(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_strict_chat_job_v17(uuid,integer) to service_role;
revoke all on function public.yield_strict_chat_job_v17(uuid,uuid,text,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.yield_strict_chat_job_v17(uuid,uuid,text,jsonb,text,uuid) to service_role;

commit;
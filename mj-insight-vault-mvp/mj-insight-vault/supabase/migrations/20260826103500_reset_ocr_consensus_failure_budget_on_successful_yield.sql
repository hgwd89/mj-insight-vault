begin;

create or replace function public.yield_ocr_consensus_job_v11(
  p_job_id uuid,
  p_lease_token uuid,
  p_stage text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  if not exists(
    select 1
    from public.ocr_consensus_jobs_v11
    where id=p_job_id
      and status='running'
      and lease_token=p_lease_token
      and lease_expires_at>now()
  ) then
    raise exception 'ocr_consensus_v11_lease_invalid';
  end if;

  update public.ocr_consensus_jobs_v11
  set status='queued',
      failure_count=0,
      lease_token=null,
      lease_expires_at=null,
      error_message=null,
      updated_at=now()
  where id=p_job_id;

  return jsonb_build_object(
    'status','queued',
    'completed_stage',left(coalesce(p_stage,''),100),
    'failure_count',0
  );
end
$function$;

revoke all on function public.yield_ocr_consensus_job_v11(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.yield_ocr_consensus_job_v11(uuid,uuid,text) to postgres, service_role;

commit;

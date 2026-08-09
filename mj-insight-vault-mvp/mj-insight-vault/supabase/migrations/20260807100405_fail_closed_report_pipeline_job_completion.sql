create or replace function public.enforce_formal_report_job_completion_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_pipeline text := coalesce(new.request_json->>'pipeline_version','');
  v_formal boolean := false;
  v_kind text := '';
  v_verification text := '';
  v_gate text := '';
begin
  if new.status <> 'completed'
     or new.report_id is null
     or v_pipeline not like 'report_pipeline_v3%' then
    return new;
  end if;

  select coalesce(r.is_formal_report,false),
         coalesce(r.report_kind,''),
         coalesce(r.analysis_verification_status,''),
         coalesce(r.full_corpus_gate,'')
    into v_formal,v_kind,v_verification,v_gate
  from public.chat_reports r
  where r.id=new.report_id;

  if not found or not v_formal or v_kind<>'formal' or v_gate<>'passed' then
    new.status := 'failed';
    new.progress := 100;
    new.stage := 'quality_gate';
    new.error_message := 'Linked report did not satisfy the formal report contract; provisional output was retained for audit.';
    new.finished_at := coalesce(new.finished_at,now());
    new.next_retry_at := null;
    new.lease_token := null;
    new.lease_expires_at := null;
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_formal_report_job_completion_v1() from public,anon,authenticated;
grant execute on function public.enforce_formal_report_job_completion_v1() to postgres,service_role;

drop trigger if exists trg_zzzz_enforce_formal_report_job_completion_v1 on public.chat_jobs;
create trigger trg_zzzz_enforce_formal_report_job_completion_v1
before insert or update of status,report_id,request_json on public.chat_jobs
for each row execute function public.enforce_formal_report_job_completion_v1();

update public.chat_jobs j
set status='failed',
    progress=100,
    stage='quality_gate',
    error_message='Linked report did not satisfy the formal report contract; provisional output was retained for audit.',
    next_retry_at=null,
    lease_token=null,
    lease_expires_at=null,
    finished_at=coalesce(j.finished_at,now()),
    updated_at=now()
from public.chat_reports r
where j.report_id=r.id
  and j.status='completed'
  and coalesce(j.request_json->>'pipeline_version','') like 'report_pipeline_v3%'
  and (coalesce(r.is_formal_report,false)=false or coalesce(r.report_kind,'')<>'formal' or coalesce(r.full_corpus_gate,'')<>'passed');
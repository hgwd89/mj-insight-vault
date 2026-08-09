begin;

create or replace function public.claim_verified_theme_report_note_job_v15(p_source_job_id uuid,p_lease_seconds integer default 240)
returns setof public.verified_theme_report_note_jobs_v8
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare v_run uuid;v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  select rr.id into v_run from public.verified_theme_report_runs_v8 rr join public.current_verified_theme_analysis_proof_v8 p on p.id=rr.analysis_proof_receipt_id
  where rr.source_job_id=p_source_job_id and rr.status='notes' and rr.request_fingerprint=public.verified_report_request_fingerprint_v15(p_source_job_id) limit 1;
  if v_run is null then return; end if;
  update public.verified_theme_report_note_jobs_v8 set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='report note lease expired too many times',finished_at=now(),updated_at=now()
  where run_id=v_run and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;
  select j.id,j.status,
         case when not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') then 'generator'
              when not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='critic') then 'critic' else null end
    into v_id,v_status,v_pass
  from public.verified_theme_report_note_jobs_v8 j
  where j.run_id=v_run and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now())) and j.failure_count<4
    and (not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') or not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='critic'))
  order by j.candidate_id for update skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_theme_report_note_jobs_v8 set status='running',active_pass_kind=v_pass,lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.verified_theme_report_note_jobs_v8 where id=v_id;
end
$function$;

create or replace function public.claim_verified_theme_report_final_job_v15(p_source_job_id uuid,p_lease_seconds integer default 240)
returns setof public.verified_theme_report_final_jobs_v8
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare v_run uuid;v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  select rr.id into v_run from public.verified_theme_report_runs_v8 rr join public.current_verified_theme_analysis_proof_v8 p on p.id=rr.analysis_proof_receipt_id
  where rr.source_job_id=p_source_job_id and rr.status='finalizing' and rr.request_fingerprint=public.verified_report_request_fingerprint_v15(p_source_job_id) limit 1;
  if v_run is null then return; end if;
  update public.verified_theme_report_final_jobs_v8 set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='final report lease expired too many times',finished_at=now(),updated_at=now()
  where run_id=v_run and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;
  select j.id,j.status,
         case when not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') then 'generator'
              when not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='critic') then 'critic' else null end
  into v_id,v_status,v_pass
  from public.verified_theme_report_final_jobs_v8 j
  where j.run_id=v_run and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now())) and j.failure_count<4
    and (not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') or not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='critic'))
  order by j.created_at for update skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_theme_report_final_jobs_v8 set status='running',active_pass_kind=v_pass,lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.verified_theme_report_final_jobs_v8 where id=v_id;
end
$function$;

revoke all on function public.claim_verified_theme_report_note_job_v15(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_verified_theme_report_note_job_v15(uuid,integer) to service_role;
revoke all on function public.claim_verified_theme_report_final_job_v15(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_verified_theme_report_final_job_v15(uuid,integer) to service_role;
revoke execute on function public.claim_verified_theme_report_note_job_v8(integer) from service_role;
revoke execute on function public.claim_verified_theme_report_final_job_v8(integer) from service_role;

commit;
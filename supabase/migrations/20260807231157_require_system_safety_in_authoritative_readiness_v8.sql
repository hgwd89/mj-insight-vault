create or replace view public.aaaa_pipeline_readiness_v8
with (security_invoker=true)
as
select r.*,
       s.active_legacy_cron_count,
       s.orphan_legacy_active_job_count,
       s.legacy_formal_report_count,
       s.invalid_v6_formal_report_count,
       s.externally_executable_security_definer_count,
       s.strict_rls_disabled_table_count,
       s.strict_external_dml_grant_count,
       s.system_safety_gate,
       case when s.system_safety_gate<>'passed' then 'system_safety_gate_failed' else r.readiness_status end readiness_status_v8
from public.aaaa_pipeline_readiness_v7 r
cross join public.strict_system_safety_audit_v1 s;

revoke all on public.aaaa_pipeline_readiness_v8 from public,anon,authenticated;
grant select on public.aaaa_pipeline_readiness_v8 to service_role;

create or replace function public.strict_analysis_prerequisites_pass_v8(p_analysis_run_id uuid)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
select public.strict_analysis_prerequisites_pass_v7(p_analysis_run_id)
  and exists(select 1 from public.strict_system_safety_audit_v1 where system_safety_gate='passed');
$$;

revoke execute on function public.strict_analysis_prerequisites_pass_v8(uuid) from public,anon,authenticated;
grant execute on function public.strict_analysis_prerequisites_pass_v8(uuid) to service_role;

create or replace function public.create_formal_report_job_v6(p_analysis_run_id uuid,p_user_query text)
returns uuid
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare p public.theme_analysis_proof_receipts_v6%rowtype;v_id uuid;begin
  if not public.strict_analysis_prerequisites_pass_v8(p_analysis_run_id) then raise exception 'report_v6_strict_prerequisites_not_ready'; end if;
  select * into p from public.theme_analysis_proof_receipts_v6 where analysis_run_id=p_analysis_run_id;
  if not found or not public.theme_analysis_proof_integrity_v6(p_analysis_run_id) or p.selected_theme_count<1 then raise exception 'report_v6_theme_proof_invalid_or_empty'; end if;
  insert into public.formal_report_jobs_v6(analysis_run_id,theme_proof_receipt_id,user_query,candidate_set_fingerprint,census_identity_fingerprint,metrics_fingerprint,selection_fingerprint,evidence_fingerprint,selected_theme_count)
  values(p_analysis_run_id,p.id,btrim(p_user_query),p.candidate_set_fingerprint,p.census_identity_fingerprint,p.metrics_fingerprint,p.selection_fingerprint,p.evidence_fingerprint,p.selected_theme_count)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.claim_formal_report_job_v6(p_lease_seconds integer default 420)
returns setof public.formal_report_jobs_v6
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();begin
  select j.id into v_id from public.formal_report_jobs_v6 j
  where (j.status='queued' or (j.status='running' and (j.lease_expires_at is null or j.lease_expires_at<now())))
    and j.attempt_count<4 and (j.next_retry_at is null or j.next_retry_at<=now())
    and public.strict_analysis_prerequisites_pass_v8(j.analysis_run_id)
  order by j.created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.formal_report_jobs_v6 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(600,coalesce(p_lease_seconds,420)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),last_error_class=null,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.formal_report_jobs_v6 where id=v_id;
end $$;
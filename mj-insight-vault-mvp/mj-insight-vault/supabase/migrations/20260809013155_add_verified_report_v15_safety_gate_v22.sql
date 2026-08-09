begin;
create or replace view public.verified_report_v15_safety_gate_v22
with (security_invoker=true)
as
with v15 as (
  select r.id,r.source_job_id,
         case when coalesce(r.answer_json->>'formal_gate_version','')='verified_theme_report_v15_query_bound'
                   and r.is_formal_report=true and r.full_corpus_gate='passed'
                   and r.source_job_id is not null
                   and coalesce(r.answer_json->>'verified_report_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   and public.verified_theme_report_integrity_v15((r.answer_json->>'verified_report_id')::uuid,r.source_job_id)
                   and r.answer_json=public.verified_theme_report_payload_v15((r.answer_json->>'verified_report_id')::uuid,r.source_job_id)
              then true else false end valid
  from public.chat_reports r
  where coalesce(r.answer_json->>'formal_gate_version','')='verified_theme_report_v15_query_bound'
), bad as (
  select count(*)::integer n from v15 where not valid
), active_jobs as (
  select count(*)::integer n
  from public.verified_theme_report_runs_v8 rr
  where rr.status in ('notes','finalizing') and (rr.source_job_id is null or rr.request_fingerprint is distinct from public.verified_report_request_fingerprint_v15(rr.source_job_id))
)
select coalesce((select count(*) from v15),0)::integer v15_formal_report_count,
       coalesce((select n from bad),0)::integer invalid_v15_formal_report_count,
       coalesce((select n from active_jobs),0)::integer stale_active_v15_report_run_count,
       case when coalesce((select n from bad),0)=0 and coalesce((select n from active_jobs),0)=0 then 'passed' else 'failed' end safety_gate;
revoke all on public.verified_report_v15_safety_gate_v22 from public,anon,authenticated;
grant select on public.verified_report_v15_safety_gate_v22 to service_role;
commit;
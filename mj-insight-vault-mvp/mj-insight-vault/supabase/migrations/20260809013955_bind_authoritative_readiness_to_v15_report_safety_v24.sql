begin;

alter view public.aaaa_pipeline_readiness_v8 rename to aaaa_pipeline_readiness_v8_core_v24;

create view public.aaaa_pipeline_readiness_v8
with (security_invoker=true)
as
select (jsonb_populate_record(
  null::public.aaaa_pipeline_readiness_v8_core_v24,
  to_jsonb(c) || jsonb_build_object(
    'system_safety_gate',case when c.system_safety_gate='passed' and v.safety_gate='passed' then 'passed' else 'failed' end,
    'readiness_status_v8',case when v.safety_gate<>'passed' then 'system_safety_gate_failed' else c.readiness_status_v8 end
  )
)).*
from public.aaaa_pipeline_readiness_v8_core_v24 c
cross join public.verified_report_v15_safety_gate_v22 v;

revoke all on public.aaaa_pipeline_readiness_v8 from public,anon,authenticated;
grant select on public.aaaa_pipeline_readiness_v8 to service_role;

create or replace view public.strict_system_safety_audit_v24
with (security_invoker=true)
as
select s.active_legacy_cron_count,s.orphan_legacy_active_job_count,s.legacy_formal_report_count,s.invalid_v6_formal_report_count,
       s.externally_executable_security_definer_count,s.strict_rls_disabled_table_count,s.strict_external_dml_grant_count,
       v.v15_formal_report_count,v.invalid_v15_formal_report_count,v.stale_active_v15_report_run_count,
       case when s.system_safety_gate='passed' and v.safety_gate='passed' then 'passed' else 'failed' end system_safety_gate
from public.strict_system_safety_audit_v1 s
cross join public.verified_report_v15_safety_gate_v22 v;
revoke all on public.strict_system_safety_audit_v24 from public,anon,authenticated;
grant select on public.strict_system_safety_audit_v24 to service_role;

commit;
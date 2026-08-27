begin;

-- Static fail-closed gate while the V21 full-corpus consensus rollout does not yet
-- exist.  This view is intentionally incapable of passing.  A future migration may
-- replace it only together with the explicit full-rollout job creation/execution path
-- and an authoritative all-target completion predicate.
create or replace view public.ocr_consensus_full_rollout_gate_v28
with (security_invoker = true)
as
select
  'blocked_pre_rollout'::text as rollout_gate,
  'V21 full-corpus OCR consensus rollout is not implemented/released; canary comparison is not a rollout completion receipt.'::text as reason,
  null::uuid as release_receipt_id,
  null::uuid as cohort_id;

revoke all on public.ocr_consensus_full_rollout_gate_v28 from public,anon,authenticated;
grant select on public.ocr_consensus_full_rollout_gate_v28 to postgres,service_role;

-- The old post-OCR drain previously trusted ocr_verification_gate_v2 alone.  That
-- relation is production-only DDL and its binding to the new V21 consensus cannot be
-- proven while authoritative PostgreSQL is unreachable.  Require the explicit V28
-- full-rollout gate first so legacy OCR completion can never advance the verified
-- pipeline ahead of the new consensus rollout.
create or replace function public.drain_verified_pipeline_after_ocr_v2()
returns jsonb
language plpgsql
security invoker
set search_path to 'pg_catalog','public','cron'
as $function$
declare
  v_consensus_rollout_gate text;
  v_consensus_rollout_reason text;
  v_safety text;
  v_ocr_gate text;
  v_report_gate text;
  v_report_safety text;
  v_formal_report_count integer := 0;
  v_request_id bigint;
begin
  select rollout_gate,reason
    into v_consensus_rollout_gate,v_consensus_rollout_reason
  from public.ocr_consensus_full_rollout_gate_v28
  limit 1;
  if v_consensus_rollout_gate is distinct from 'passed' then
    return jsonb_build_object(
      'status','blocked',
      'reason','ocr_consensus_full_rollout_gate_v28',
      'gate',v_consensus_rollout_gate,
      'detail',v_consensus_rollout_reason
    );
  end if;

  select system_safety_gate into v_safety
  from public.strict_system_safety_audit_v24
  limit 1;
  if v_safety is distinct from 'passed' then
    return jsonb_build_object('status','blocked','reason','system_safety_gate','gate',v_safety);
  end if;

  select ocr_verification_gate into v_ocr_gate
  from public.ocr_verification_gate_v2
  limit 1;
  if v_ocr_gate is distinct from 'passed' then
    return jsonb_build_object('status','waiting','reason','ocr_verification_gate','gate',v_ocr_gate);
  end if;

  select report_gate into v_report_gate
  from public.verified_theme_report_gate_v8
  limit 1;
  select safety_gate,v15_formal_report_count
    into v_report_safety,v_formal_report_count
  from public.verified_report_v15_safety_gate_v22
  limit 1;

  if v_report_gate = 'passed' and v_report_safety = 'passed' and coalesce(v_formal_report_count,0) > 0 then
    if exists(select 1 from cron.job where jobname='mj-verified-pipeline-after-ocr-v2') then
      perform cron.unschedule('mj-verified-pipeline-after-ocr-v2');
    end if;
    return jsonb_build_object('status','complete','cron_unscheduled',true,'formal_reports',v_formal_report_count);
  end if;

  v_request_id := public.request_verified_pipeline_scheduler_tick_v1();
  return jsonb_build_object(
    'status',case when v_request_id is null then 'busy_or_disabled' else 'kicked' end,
    'request_id',v_request_id,
    'ocr_consensus_full_rollout_gate',v_consensus_rollout_gate,
    'ocr_gate',v_ocr_gate,
    'report_gate',v_report_gate,
    'report_safety',v_report_safety,
    'formal_reports',v_formal_report_count
  );
end
$function$;

revoke all on function public.drain_verified_pipeline_after_ocr_v2() from public,anon,authenticated;
grant execute on function public.drain_verified_pipeline_after_ocr_v2() to postgres,service_role;

commit;

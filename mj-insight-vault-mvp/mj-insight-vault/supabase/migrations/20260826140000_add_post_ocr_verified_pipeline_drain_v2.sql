create or replace function public.drain_verified_pipeline_after_ocr_v2()
returns jsonb
language plpgsql
security invoker
set search_path to 'pg_catalog', 'public', 'cron'
as $function$
declare
  v_safety text;
  v_ocr_gate text;
  v_report_gate text;
  v_report_safety text;
  v_formal_report_count integer := 0;
  v_request_id bigint;
begin
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
  select safety_gate, v15_formal_report_count
    into v_report_safety, v_formal_report_count
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
    'ocr_gate',v_ocr_gate,
    'report_gate',v_report_gate,
    'report_safety',v_report_safety,
    'formal_reports',v_formal_report_count
  );
end
$function$;

revoke all on function public.drain_verified_pipeline_after_ocr_v2() from public, anon, authenticated;
grant execute on function public.drain_verified_pipeline_after_ocr_v2() to postgres, service_role;

do $block$
begin
  if not exists(select 1 from cron.job where jobname='mj-verified-pipeline-after-ocr-v2') then
    perform cron.schedule(
      'mj-verified-pipeline-after-ocr-v2',
      '* * * * *',
      'select public.drain_verified_pipeline_after_ocr_v2();'
    );
  end if;
end
$block$;

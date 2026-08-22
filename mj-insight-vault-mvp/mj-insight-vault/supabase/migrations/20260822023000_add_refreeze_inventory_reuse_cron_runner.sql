create or replace function public.run_refreeze_inventory_reuse_once_v1(
  p_source_freeze uuid,
  p_limit integer default 5,
  p_cron_job_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions', 'cron'
set statement_timeout to '150s'
as $function$
declare
  v_lock_key bigint := hashtextextended('run_refreeze_inventory_reuse_once_v1:' || coalesce(p_source_freeze::text, ''), 0);
  v_result jsonb;
  v_reused integer;
begin
  if not pg_try_advisory_lock(v_lock_key) then
    return jsonb_build_object('status', 'skipped', 'reason', 'refreeze_reuse_already_running', 'api_calls', 0);
  end if;

  begin
    select public.bulk_reuse_refreeze_completed_inventory_fast_v1(p_source_freeze, p_limit)
      into v_result;

    v_reused := coalesce((v_result->>'reused')::integer, 0);
    if v_reused = 0 and coalesce(p_cron_job_name, '') <> '' then
      perform cron.unschedule(p_cron_job_name);
      v_result := v_result || jsonb_build_object('unscheduled', true, 'cron_job_name', p_cron_job_name);
    end if;

    perform pg_advisory_unlock(v_lock_key);
    return v_result;
  exception when others then
    perform pg_advisory_unlock(v_lock_key);
    raise;
  end;
end
$function$;

revoke all on function public.run_refreeze_inventory_reuse_once_v1(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.run_refreeze_inventory_reuse_once_v1(uuid, integer, text) to service_role;

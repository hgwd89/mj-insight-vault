create or replace function public.block_legacy_report_pipeline_v3_pending_v4()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare v_pipeline text := coalesce(new.request_json->>'pipeline_version','');
begin
  if v_pipeline='report_pipeline_v3'
     and new.status in ('queued','running')
     and (tg_op='INSERT' or old.status not in ('queued','running')) then
    raise exception using
      errcode='23514',
      message='report_pipeline_v3_disabled_pending_strict_v4',
      detail='Legacy report pipeline is disabled to prevent unverified full-corpus scans and wasted model calls.';
  end if;
  return new;
end;
$function$;

revoke all on function public.block_legacy_report_pipeline_v3_pending_v4() from public,anon,authenticated;
grant execute on function public.block_legacy_report_pipeline_v3_pending_v4() to postgres,service_role;

drop trigger if exists trg_000_block_legacy_report_pipeline_v3_pending_v4 on public.chat_jobs;
create trigger trg_000_block_legacy_report_pipeline_v3_pending_v4
before insert or update of status,request_json on public.chat_jobs
for each row execute function public.block_legacy_report_pipeline_v3_pending_v4();
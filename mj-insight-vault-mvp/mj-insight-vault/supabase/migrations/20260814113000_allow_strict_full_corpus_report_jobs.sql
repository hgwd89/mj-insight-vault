-- Allow the hardened report_pipeline_v3 only when callers explicitly require
-- full-corpus processing. The application still blocks report generation unless
-- the scan gate passes with exact target/analyzed counts and zero terminal
-- batches.

create or replace function public.block_legacy_report_pipeline_v3_pending_v4()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_pipeline text := coalesce(new.request_json->>'pipeline_version', '');
  v_requires_full_corpus boolean := coalesce(new.request_json->>'require_full_corpus', '') = 'true'
    or coalesce(new.request_json->>'full_corpus_required', '') = 'true';
  v_scope text := coalesce(new.request_json->>'target_scope', '');
begin
  if v_pipeline = 'report_pipeline_v3'
     and new.status in ('queued', 'running')
     and (tg_op = 'INSERT' or old.status not in ('queued', 'running'))
     and not (v_requires_full_corpus and v_scope in ('all', 'category')) then
    raise exception using
      errcode = '23514',
      message = 'report_pipeline_v3_disabled_pending_strict_v4',
      detail = 'Legacy report pipeline is disabled unless the request explicitly requires full-corpus processing.';
  end if;
  return new;
end;
$function$;

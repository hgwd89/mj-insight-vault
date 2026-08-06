-- Prevent provisional or fallback reports from being classified as formal.
-- Formal classification is a database safety boundary and must not trust a single quality flag.

create or replace function public.sync_chat_report_metadata()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  payload jsonb := coalesce(new.answer_json, '{}'::jsonb);
  gate text := coalesce(payload ->> 'full_corpus_gate', payload #>> '{source_coverage,full_corpus_gate}', 'failed');
  quality_status text := coalesce(payload #>> '{quality_gate,status}', '');
  generation_status_value text := coalesce(nullif(payload ->> 'generation_status', ''), 'completed');
  report_kind_value text := coalesce(payload ->> 'report_kind', '');
  generation_warning text := lower(coalesce(payload ->> 'generation_warning', ''));
  provisional boolean := lower(coalesce(
    payload ->> 'analysis_is_provisional',
    payload #>> '{source_coverage,analysis_is_provisional}',
    payload #>> '{coverage_diagnosis,analysis_is_provisional}',
    'false'
  )) in ('true', '1', 'yes');
  blocked boolean := generation_status_value = 'blocked'
    or report_kind_value = 'diagnostic'
    or lower(coalesce(payload ->> 'report_chat', 'false')) in ('true', '1', 'yes');
  fallback_used boolean := generation_warning like '%emergency_fallback%'
    or generation_warning like '%extractive_fallback%'
    or generation_warning like '%openai_api_key missing%'
    or lower(coalesce(payload ->> 'fallback_used', 'false')) in ('true', '1', 'yes');
  formal boolean := gate = 'passed'
    and quality_status = 'passed'
    and not provisional
    and not blocked
    and not fallback_used;
begin
  new.full_corpus_gate := gate;
  new.is_formal_report := formal;
  new.generation_status := generation_status_value;
  new.report_kind := case
    when report_kind_value = 'diagnostic' or new.generation_status = 'blocked' then 'diagnostic'
    when lower(coalesce(payload ->> 'report_chat', 'false')) in ('true', '1', 'yes') then 'followup'
    when formal then 'formal'
    else 'provisional'
  end;
  new.analysis_verification_status := case
    when formal then 'full_corpus_verified'
    when new.report_kind = 'followup' then 'derived_followup'
    when new.report_kind = 'diagnostic' then 'blocked_diagnostic'
    when provisional then 'provisional_unverified'
    when fallback_used then 'fallback_unverified'
    else 'quality_unverified'
  end;
  return new;
end;
$$;

-- Re-evaluate every existing row through the hardened trigger.
update public.chat_reports
set answer_json = answer_json;

create index if not exists chat_reports_strict_formal_idx
  on public.chat_reports(created_at desc)
  where is_formal_report = true
    and analysis_verification_status = 'full_corpus_verified'
    and full_corpus_gate = 'passed';

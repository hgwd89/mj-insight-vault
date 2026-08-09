-- A count-complete scan is not sufficient for a formal report.
-- Require v2 batch validation and proof that every batch is represented in the final synthesis input.

create or replace view public.formal_corpus_articles_v1
with (security_invoker = true)
as
select a.*
from public.articles a
where (a.status is null or a.status not in ('deleted', 'excluded', 'rejected'))
  and coalesce(a.article_type, '') = 'article'
  and coalesce(btrim(a.ocr_text), '') <> '';

revoke all on public.formal_corpus_articles_v1 from public, anon, authenticated;
grant select on public.formal_corpus_articles_v1 to postgres, service_role;

create or replace function public.sync_chat_report_metadata()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  payload jsonb := coalesce(new.answer_json, '{}'::jsonb);
  gate text := coalesce(payload ->> 'full_corpus_gate', payload #>> '{source_coverage,full_corpus_gate}', 'failed');
  integrity_gate text := coalesce(payload ->> 'full_corpus_integrity_gate', payload #>> '{source_coverage,full_corpus_integrity_gate}', 'failed');
  prompt_version text := coalesce(payload ->> 'full_corpus_prompt_version', payload #>> '{source_coverage,full_corpus_prompt_version}', '');
  all_batches_represented boolean := lower(coalesce(
    payload ->> 'final_context_all_batches_represented',
    payload #>> '{source_coverage,final_context_all_batches_represented}',
    'false'
  )) in ('true', '1', 'yes');
  omitted_batches integer := coalesce(nullif(
    coalesce(payload ->> 'final_context_omitted_batches', payload #>> '{source_coverage,final_context_omitted_batches}', '0'),
    ''
  )::integer, 0);
  represented_batches integer := coalesce(nullif(
    coalesce(payload ->> 'final_context_represented_batches', payload #>> '{source_coverage,final_context_represented_batches}', '0'),
    ''
  )::integer, 0);
  represented_articles integer := coalesce(nullif(
    coalesce(payload ->> 'final_context_represented_article_count', payload #>> '{source_coverage,final_context_represented_article_count}', '0'),
    ''
  )::integer, 0);
  quality_status text := coalesce(payload #>> '{quality_gate,status}', '');
  gate_version text := coalesce(payload ->> 'formal_gate_version', payload #>> '{raw_quality_gate,version}', '');
  validation_mode text := coalesce(payload #>> '{raw_quality_gate,validation_mode}', '');
  generation_status_value text := coalesce(nullif(payload ->> 'generation_status', ''), 'completed');
  report_kind_value text := coalesce(payload ->> 'report_kind', '');
  generation_warning text := lower(coalesce(payload ->> 'generation_warning', ''));
  report_chat boolean := lower(coalesce(payload ->> 'report_chat', 'false')) in ('true', '1', 'yes');
  provisional boolean := lower(coalesce(
    payload ->> 'analysis_is_provisional',
    payload #>> '{source_coverage,analysis_is_provisional}',
    payload #>> '{coverage_diagnosis,analysis_is_provisional}',
    'false'
  )) in ('true', '1', 'yes');
  blocked boolean := generation_status_value = 'blocked'
    or report_kind_value = 'diagnostic'
    or report_chat;
  fallback_used boolean := generation_warning like '%emergency_fallback%'
    or generation_warning like '%extractive_fallback%'
    or generation_warning like '%openai_api_key missing%'
    or lower(coalesce(payload ->> 'fallback_used', 'false')) in ('true', '1', 'yes');
  full_corpus_candidate boolean := gate = 'passed' and not blocked;
  integrity_verified boolean := integrity_gate = 'passed'
    and prompt_version = 'full_corpus_batch_v2'
    and all_batches_represented
    and omitted_batches = 0
    and represented_batches > 0
    and represented_articles > 0;
  formal boolean := full_corpus_candidate
    and integrity_verified
    and gate_version = 'formal_gate_v2'
    and validation_mode = 'raw_before_enrichment'
    and quality_status = 'passed'
    and not provisional
    and not fallback_used;
begin
  if tg_op = 'INSERT'
    and full_corpus_candidate
    and gate_version <> 'formal_gate_v2' then
    raise exception using
      errcode = '23514',
      message = 'formal_report_gate_version_missing',
      detail = 'A full-corpus report must pass formal_gate_v2 before persistence.';
  end if;

  if tg_op = 'INSERT'
    and full_corpus_candidate
    and not integrity_verified then
    raise exception using
      errcode = '23514',
      message = 'formal_report_integrity_gate_missing',
      detail = 'A formal report requires full_corpus_batch_v2 and an all-batch final context with zero omissions.';
  end if;

  new.full_corpus_gate := gate;
  new.is_formal_report := formal;
  new.generation_status := generation_status_value;
  new.report_kind := case
    when report_kind_value = 'diagnostic' or new.generation_status = 'blocked' then 'diagnostic'
    when report_chat then 'followup'
    when formal then 'formal'
    else 'provisional'
  end;
  new.analysis_verification_status := case
    when formal then 'full_corpus_verified'
    when new.report_kind = 'followup' then 'derived_followup'
    when new.report_kind = 'diagnostic' then 'blocked_diagnostic'
    when not integrity_verified and full_corpus_candidate then 'integrity_unverified'
    when provisional then 'provisional_unverified'
    when fallback_used then 'fallback_unverified'
    when gate_version <> 'formal_gate_v2' then 'gate_version_unverified'
    else 'quality_unverified'
  end;
  return new;
end;
$$;

update public.chat_reports
set answer_json = answer_json
where full_corpus_gate = 'passed'
   or is_formal_report = true;

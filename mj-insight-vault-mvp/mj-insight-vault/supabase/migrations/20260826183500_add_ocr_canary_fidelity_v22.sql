-- Diagnostic-only OCR canary fidelity view.
-- This does not participate in any OCR acceptance gate and must never lower thresholds.
-- Existing decision metrics are surfaced side-by-side; cross-method text metrics below are
-- review signals only and are never used to create canonical OCR receipts.

create or replace view public.ocr_canary_fidelity_v22
with (security_invoker = true)
as
select
  c.consensus_job_id,
  c.source_job_id,
  c.article_id,
  c.job_status,
  c.current_decision_status,
  c.current_selected_source,
  c.current_sol_confidence,
  c.current_terra_confidence,
  c.current_google_sol_similarity,
  c.current_google_terra_similarity,
  c.current_sol_terra_similarity,
  c.current_google_sol_numeric_equal,
  c.current_google_terra_numeric_equal,
  c.current_sol_terra_numeric_equal,
  c.current_sol_terra_proper_noun_agreement,

  c.v16_sol_confidence,
  c.v16_terra_confidence,
  c.v16_decision_status,
  c.v16_google_sol_similarity,
  c.v16_sol_terra_similarity,
  c.v16_google_sol_numeric_equal,
  c.v16_sol_terra_numeric_equal,
  c.v16_sol_terra_proper_noun_agreement,

  c.legacy_sol_confidence,
  c.legacy_terra_confidence,
  c.legacy_decision_status,
  c.legacy_google_sol_similarity,
  c.legacy_sol_terra_similarity,
  c.legacy_google_sol_numeric_equal,
  c.legacy_sol_terra_numeric_equal,
  c.legacy_sol_terra_proper_noun_agreement,

  char_length(coalesce(c.google_text,'')) as google_char_count,
  char_length(coalesce(c.current_sol_text,'')) as current_sol_char_count,
  char_length(coalesce(c.current_terra_text,'')) as current_terra_char_count,
  char_length(coalesce(c.current_canonical_text,'')) as current_canonical_char_count,
  char_length(coalesce(c.v16_sol_text,'')) as v16_sol_char_count,
  char_length(coalesce(c.v16_terra_text,'')) as v16_terra_char_count,
  char_length(coalesce(c.legacy_sol_text,'')) as legacy_sol_char_count,
  char_length(coalesce(c.legacy_terra_text,'')) as legacy_terra_char_count,

  case
    when greatest(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.current_sol_text,''))) = 0 then null
    else least(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.current_sol_text,'')))::numeric
       / greatest(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.current_sol_text,'')))::numeric
  end as google_sol_length_ratio,
  case
    when greatest(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.current_terra_text,''))) = 0 then null
    else least(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.current_terra_text,'')))::numeric
       / greatest(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.current_terra_text,'')))::numeric
  end as sol_terra_length_ratio,
  case
    when greatest(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.v16_sol_text,''))) = 0 then null
    else least(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.v16_sol_text,'')))::numeric
       / greatest(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.v16_sol_text,'')))::numeric
  end as google_v16_sol_length_ratio,
  case
    when greatest(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.legacy_sol_text,''))) = 0 then null
    else least(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.legacy_sol_text,'')))::numeric
       / greatest(char_length(coalesce(c.google_text,'')), char_length(coalesce(c.legacy_sol_text,'')))::numeric
  end as google_legacy_sol_length_ratio,
  case
    when greatest(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.v16_sol_text,''))) = 0 then null
    else least(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.v16_sol_text,'')))::numeric
       / greatest(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.v16_sol_text,'')))::numeric
  end as current_v16_sol_length_ratio,
  case
    when greatest(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.legacy_sol_text,''))) = 0 then null
    else least(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.legacy_sol_text,'')))::numeric
       / greatest(char_length(coalesce(c.current_sol_text,'')), char_length(coalesce(c.legacy_sol_text,'')))::numeric
  end as current_legacy_sol_length_ratio,

  case
    when c.current_sol_text is null or c.v16_sol_text is null then null::real
    else similarity(public.normalize_ocr_consensus_text_v2(c.current_sol_text), public.normalize_ocr_consensus_text_v2(c.v16_sol_text))
  end as current_v16_sol_similarity,
  case
    when c.current_sol_text is null or c.legacy_sol_text is null then null::real
    else similarity(public.normalize_ocr_consensus_text_v2(c.current_sol_text), public.normalize_ocr_consensus_text_v2(c.legacy_sol_text))
  end as current_legacy_sol_similarity,
  case
    when c.v16_sol_text is null or c.legacy_sol_text is null then null::real
    else similarity(public.normalize_ocr_consensus_text_v2(c.v16_sol_text), public.normalize_ocr_consensus_text_v2(c.legacy_sol_text))
  end as v16_legacy_sol_similarity,
  case
    when c.current_sol_text is null or c.v16_sol_text is null then null::boolean
    else public.ocr_numeric_tokens_v2(c.current_sol_text) = public.ocr_numeric_tokens_v2(c.v16_sol_text)
  end as current_v16_sol_numeric_equal,
  case
    when c.current_sol_text is null or c.legacy_sol_text is null then null::boolean
    else public.ocr_numeric_tokens_v2(c.current_sol_text) = public.ocr_numeric_tokens_v2(c.legacy_sol_text)
  end as current_legacy_sol_numeric_equal,
  case
    when c.v16_sol_text is null or c.legacy_sol_text is null then null::boolean
    else public.ocr_numeric_tokens_v2(c.v16_sol_text) = public.ocr_numeric_tokens_v2(c.legacy_sol_text)
  end as v16_legacy_sol_numeric_equal,

  case
    when char_length(coalesce(c.current_sol_text,'')) = 0 then null
    else (char_length(coalesce(c.current_sol_text,'')) - char_length(replace(coalesce(c.current_sol_text,''),'〓','')))::numeric
       / char_length(coalesce(c.current_sol_text,''))::numeric
  end as current_sol_unreadable_rate,
  case
    when char_length(coalesce(c.current_terra_text,'')) = 0 then null
    else (char_length(coalesce(c.current_terra_text,'')) - char_length(replace(coalesce(c.current_terra_text,''),'〓','')))::numeric
       / char_length(coalesce(c.current_terra_text,''))::numeric
  end as current_terra_unreadable_rate,
  case
    when char_length(coalesce(c.v16_sol_text,'')) = 0 then null
    else (char_length(coalesce(c.v16_sol_text,'')) - char_length(replace(coalesce(c.v16_sol_text,''),'〓','')))::numeric
       / char_length(coalesce(c.v16_sol_text,''))::numeric
  end as v16_sol_unreadable_rate,
  case
    when char_length(coalesce(c.legacy_sol_text,'')) = 0 then null
    else (char_length(coalesce(c.legacy_sol_text,'')) - char_length(replace(coalesce(c.legacy_sol_text,''),'〓','')))::numeric
       / char_length(coalesce(c.legacy_sol_text,''))::numeric
  end as legacy_sol_unreadable_rate,

  left(coalesce(c.google_text,''), 240) as google_preview,
  left(coalesce(c.current_sol_text,''), 240) as current_sol_preview,
  left(coalesce(c.current_terra_text,''), 240) as current_terra_preview,
  left(coalesce(c.current_canonical_text,''), 240) as current_canonical_preview,
  left(coalesce(c.v16_sol_text,''), 240) as v16_sol_preview,
  left(coalesce(c.v16_terra_text,''), 240) as v16_terra_preview,
  left(coalesce(c.legacy_sol_text,''), 240) as legacy_sol_preview,
  left(coalesce(c.legacy_terra_text,''), 240) as legacy_terra_preview,

  c.current_sol_piece_receipts,
  c.current_sol_expected_pieces,
  c.current_terra_piece_receipts,
  c.current_terra_expected_pieces,
  c.current_decision_reason
from public.ocr_canary_method_comparison_v19 c;

revoke all on public.ocr_canary_fidelity_v22 from public, anon, authenticated;
grant select on public.ocr_canary_fidelity_v22 to service_role;
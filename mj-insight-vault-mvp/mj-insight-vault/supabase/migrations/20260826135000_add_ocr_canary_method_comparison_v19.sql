create or replace view public.ocr_canary_method_comparison_v19
with (security_invoker = true)
as
with canary_jobs as (
  select id as consensus_job_id, source_job_id, article_count, status as job_status, failure_count, error_message
  from public.ocr_consensus_jobs_v11
  where is_canary is true
),
article_set as (
  select cj.consensus_job_id, cj.source_job_id, cj.article_count, cj.job_status, cj.failure_count, cj.error_message,
         c.article_id, c.crop_ocr_text as google_text, c.crop_ocr_text_sha256 as google_text_sha256
  from canary_jobs cj
  join public.ocr_verification_crop_ocr_v4 c on c.job_id = cj.source_job_id
  where c.crop_version = 'article_geometry_mask_composite_v3'
),
piece_progress as (
  select r.job_id as consensus_job_id, r.article_id, r.pass_kind,
         count(*)::int as piece_receipts,
         max(r.segment_count)::int as expected_pieces,
         min(r.confidence) as min_piece_confidence,
         bool_and(r.output_contract_status = 'passed') as piece_contract_passed,
         count(*) filter (where r.proper_noun_status = 'failed')::int as failed_proper_noun_pieces
  from public.ocr_independent_segment_receipts_v16 r
  join canary_jobs cj on cj.consensus_job_id = r.job_id
  group by r.job_id, r.article_id, r.pass_kind
),
current_transcriptions as (
  select t.job_id as consensus_job_id, t.article_id,
         max(t.confidence) filter (where t.pass_kind = 'sol') as current_sol_confidence,
         max(t.proper_noun_status) filter (where t.pass_kind = 'sol') as current_sol_proper_noun_status,
         max(t.output_contract_status) filter (where t.pass_kind = 'sol') as current_sol_output_contract_status,
         max(t.transcription) filter (where t.pass_kind = 'sol') as current_sol_text,
         max(t.confidence) filter (where t.pass_kind = 'terra') as current_terra_confidence,
         max(t.proper_noun_status) filter (where t.pass_kind = 'terra') as current_terra_proper_noun_status,
         max(t.output_contract_status) filter (where t.pass_kind = 'terra') as current_terra_output_contract_status,
         max(t.transcription) filter (where t.pass_kind = 'terra') as current_terra_text
  from public.ocr_independent_transcriptions_v11 t
  join canary_jobs cj on cj.consensus_job_id = t.job_id
  group by t.job_id, t.article_id
),
current_decisions as (
  select d.job_id as consensus_job_id, d.article_id,
         d.decision_status as current_decision_status,
         d.selected_source as current_selected_source,
         d.canonical_text as current_canonical_text,
         d.google_sol_similarity as current_google_sol_similarity,
         d.google_terra_similarity as current_google_terra_similarity,
         d.sol_terra_similarity as current_sol_terra_similarity,
         d.google_sol_numeric_equal as current_google_sol_numeric_equal,
         d.google_terra_numeric_equal as current_google_terra_numeric_equal,
         d.sol_terra_numeric_equal as current_sol_terra_numeric_equal,
         d.sol_terra_proper_noun_agreement as current_sol_terra_proper_noun_agreement,
         d.decision_reason as current_decision_reason
  from public.ocr_consensus_decisions_v11 d
  join canary_jobs cj on cj.consensus_job_id = d.job_id
),
latest_v16_archive as (
  select distinct on (a.job_id) a.job_id, a.snapshot_json, a.created_at
  from public.ocr_consensus_requeue_archives_v12 a
  join canary_jobs cj on cj.consensus_job_id = a.job_id
  where a.reason like 'isolated per-segment verbatim transcription v16%'
  order by a.job_id, a.created_at desc
),
v16_transcriptions as (
  select a.job_id as consensus_job_id, (t->>'article_id')::uuid as article_id,
         max((t->>'confidence')::numeric) filter (where t->>'pass_kind' = 'sol') as v16_sol_confidence,
         max(t->>'transcription') filter (where t->>'pass_kind' = 'sol') as v16_sol_text,
         max((t->>'confidence')::numeric) filter (where t->>'pass_kind' = 'terra') as v16_terra_confidence,
         max(t->>'transcription') filter (where t->>'pass_kind' = 'terra') as v16_terra_text
  from latest_v16_archive a
  cross join lateral jsonb_array_elements(coalesce(a.snapshot_json->'transcriptions','[]'::jsonb)) t
  group by a.job_id, (t->>'article_id')::uuid
),
v16_decisions as (
  select a.job_id as consensus_job_id, (d->>'article_id')::uuid as article_id,
         d->>'decision_status' as v16_decision_status,
         (d->>'google_sol_similarity')::numeric as v16_google_sol_similarity,
         (d->>'sol_terra_similarity')::numeric as v16_sol_terra_similarity,
         (d->>'google_sol_numeric_equal')::boolean as v16_google_sol_numeric_equal,
         (d->>'sol_terra_numeric_equal')::boolean as v16_sol_terra_numeric_equal,
         (d->>'sol_terra_proper_noun_agreement')::boolean as v16_sol_terra_proper_noun_agreement
  from latest_v16_archive a
  cross join lateral jsonb_array_elements(coalesce(a.snapshot_json->'decisions','[]'::jsonb)) d
),
latest_legacy_archive as (
  select distinct on (a.job_id) a.job_id, a.snapshot_json, a.created_at
  from public.ocr_consensus_requeue_archives_v12 a
  join canary_jobs cj on cj.consensus_job_id = a.job_id
  where a.reason like '%segmented vertical reading-order production canary%'
  order by a.job_id, a.created_at desc
),
legacy_transcriptions as (
  select a.job_id as consensus_job_id, (t->>'article_id')::uuid as article_id,
         max((t->>'confidence')::numeric) filter (where t->>'pass_kind' = 'sol') as legacy_sol_confidence,
         max(t->>'transcription') filter (where t->>'pass_kind' = 'sol') as legacy_sol_text,
         max((t->>'confidence')::numeric) filter (where t->>'pass_kind' = 'terra') as legacy_terra_confidence,
         max(t->>'transcription') filter (where t->>'pass_kind' = 'terra') as legacy_terra_text
  from latest_legacy_archive a
  cross join lateral jsonb_array_elements(coalesce(a.snapshot_json->'transcriptions','[]'::jsonb)) t
  group by a.job_id, (t->>'article_id')::uuid
),
legacy_decisions as (
  select a.job_id as consensus_job_id, (d->>'article_id')::uuid as article_id,
         d->>'decision_status' as legacy_decision_status,
         (d->>'google_sol_similarity')::numeric as legacy_google_sol_similarity,
         (d->>'sol_terra_similarity')::numeric as legacy_sol_terra_similarity,
         (d->>'google_sol_numeric_equal')::boolean as legacy_google_sol_numeric_equal,
         (d->>'sol_terra_numeric_equal')::boolean as legacy_sol_terra_numeric_equal,
         (d->>'sol_terra_proper_noun_agreement')::boolean as legacy_sol_terra_proper_noun_agreement
  from latest_legacy_archive a
  cross join lateral jsonb_array_elements(coalesce(a.snapshot_json->'decisions','[]'::jsonb)) d
)
select s.consensus_job_id, s.source_job_id, s.article_id, s.job_status, s.failure_count, s.error_message,
       s.google_text_sha256,
       coalesce(ps.piece_receipts,0) as current_sol_piece_receipts,
       coalesce(ps.expected_pieces,0) as current_sol_expected_pieces,
       ps.min_piece_confidence as current_sol_min_piece_confidence,
       ps.piece_contract_passed as current_sol_piece_contract_passed,
       coalesce(ps.failed_proper_noun_pieces,0) as current_sol_failed_proper_noun_pieces,
       coalesce(pt.piece_receipts,0) as current_terra_piece_receipts,
       coalesce(pt.expected_pieces,0) as current_terra_expected_pieces,
       pt.min_piece_confidence as current_terra_min_piece_confidence,
       pt.piece_contract_passed as current_terra_piece_contract_passed,
       coalesce(pt.failed_proper_noun_pieces,0) as current_terra_failed_proper_noun_pieces,
       ct.current_sol_confidence, ct.current_sol_proper_noun_status, ct.current_sol_output_contract_status,
       ct.current_terra_confidence, ct.current_terra_proper_noun_status, ct.current_terra_output_contract_status,
       cd.current_decision_status, cd.current_selected_source,
       cd.current_google_sol_similarity, cd.current_google_terra_similarity, cd.current_sol_terra_similarity,
       cd.current_google_sol_numeric_equal, cd.current_google_terra_numeric_equal, cd.current_sol_terra_numeric_equal,
       cd.current_sol_terra_proper_noun_agreement,
       v16t.v16_sol_confidence, v16t.v16_terra_confidence, v16d.v16_decision_status,
       v16d.v16_google_sol_similarity, v16d.v16_sol_terra_similarity,
       v16d.v16_google_sol_numeric_equal, v16d.v16_sol_terra_numeric_equal, v16d.v16_sol_terra_proper_noun_agreement,
       legt.legacy_sol_confidence, legt.legacy_terra_confidence, legd.legacy_decision_status,
       legd.legacy_google_sol_similarity, legd.legacy_sol_terra_similarity,
       legd.legacy_google_sol_numeric_equal, legd.legacy_sol_terra_numeric_equal, legd.legacy_sol_terra_proper_noun_agreement,
       s.google_text,
       ct.current_sol_text, ct.current_terra_text, cd.current_canonical_text,
       v16t.v16_sol_text, v16t.v16_terra_text,
       legt.legacy_sol_text, legt.legacy_terra_text,
       cd.current_decision_reason
from article_set s
left join piece_progress ps on ps.consensus_job_id=s.consensus_job_id and ps.article_id=s.article_id and ps.pass_kind='sol'
left join piece_progress pt on pt.consensus_job_id=s.consensus_job_id and pt.article_id=s.article_id and pt.pass_kind='terra'
left join current_transcriptions ct on ct.consensus_job_id=s.consensus_job_id and ct.article_id=s.article_id
left join current_decisions cd on cd.consensus_job_id=s.consensus_job_id and cd.article_id=s.article_id
left join v16_transcriptions v16t on v16t.consensus_job_id=s.consensus_job_id and v16t.article_id=s.article_id
left join v16_decisions v16d on v16d.consensus_job_id=s.consensus_job_id and v16d.article_id=s.article_id
left join legacy_transcriptions legt on legt.consensus_job_id=s.consensus_job_id and legt.article_id=s.article_id
left join legacy_decisions legd on legd.consensus_job_id=s.consensus_job_id and legd.article_id=s.article_id;

revoke all on public.ocr_canary_method_comparison_v19 from public, anon, authenticated;
grant select on public.ocr_canary_method_comparison_v19 to service_role;

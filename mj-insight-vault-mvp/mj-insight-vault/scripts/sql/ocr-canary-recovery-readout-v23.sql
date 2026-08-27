-- READ ONLY: one-shot authoritative state capture for the current OCR canary recovery.
-- This statement intentionally performs no mutation. Run it only against the canonical
-- production database after connectivity returns, before any restart or 538-job rollout.

with canary_jobs as (
  select
    id,
    source_job_id,
    pipeline_version,
    article_count,
    is_canary,
    status,
    failure_count,
    lease_token is not null as has_lease_token,
    lease_expires_at,
    error_message,
    created_at,
    updated_at,
    finished_at
  from public.ocr_consensus_jobs_v11
  where is_canary is true
),
recovery_candidate_jobs as (
  select *
  from canary_jobs
  where status in ('failed','queued','running')
),
canary_ids as (
  select id from canary_jobs
),
lease_summary as (
  select
    j.id as job_id,
    j.status,
    j.failure_count,
    j.has_lease_token,
    j.lease_expires_at,
    case
      when j.lease_expires_at is null then 'none'
      when j.lease_expires_at > now() then 'active'
      else 'expired'
    end as lease_state,
    j.error_message,
    j.updated_at,
    j.finished_at
  from canary_jobs j
),
piece_summary as (
  select
    r.job_id,
    r.pass_kind,
    r.article_id,
    r.segmentation_version,
    count(*)::integer as piece_receipts,
    min(r.sequence)::integer as min_sequence,
    max(r.sequence)::integer as max_sequence,
    max(r.segment_count)::integer as declared_piece_count,
    min(r.confidence) as min_piece_confidence,
    count(*) filter (where r.output_contract_status = 'failed')::integer as failed_output_contracts,
    count(*) filter (where r.proper_noun_status = 'failed')::integer as failed_proper_noun_checks,
    count(*) filter (where position('〓' in r.transcription) > 0)::integer as receipts_with_unreadable_marker
  from public.ocr_independent_segment_receipts_v16 r
  where r.job_id in (select id from canary_ids)
  group by r.job_id,r.pass_kind,r.article_id,r.segmentation_version
),
transcription_summary as (
  select
    t.job_id,
    t.pass_kind,
    t.article_id,
    t.confidence,
    t.proper_noun_status,
    t.output_contract_status,
    length(t.transcription)::integer as transcription_chars,
    position('〓' in t.transcription) > 0 as has_unreadable_marker,
    t.created_at
  from public.ocr_independent_transcriptions_v11 t
  where t.job_id in (select id from canary_ids)
),
decision_rows as (
  select d.*
  from public.ocr_consensus_decisions_v11 d
  where d.job_id in (select id from canary_ids)
),
canonical_rows as (
  select v.*
  from public.article_ocr_verifications_v11 v
  where v.source_consensus_job_id in (select id from canary_ids)
),
requeue_rows as (
  select a.*
  from public.ocr_consensus_requeue_archives_v12 a
  where a.job_id in (select id from canary_ids)
  order by a.created_at desc
),
resume_rows as (
  select r.*
  from public.ocr_consensus_resume_receipts_v19 r
  where r.job_id in (select id from canary_ids)
  order by r.created_at desc
)
select jsonb_build_object(
  'captured_at', now(),
  'database', current_database(),
  'server_version', current_setting('server_version'),
  'all_canary_job_count', (select count(*) from canary_jobs),
  'terminal_canary_job_count', (select count(*) from canary_jobs where status in ('completed','needs_review')),
  'expected_recovery_candidate_job_count', 2,
  'recovery_candidate_job_count', (select count(*) from recovery_candidate_jobs),
  'recovery_candidate_cardinality_matches_expected', ((select count(*) from recovery_candidate_jobs) = 2),
  'recovery_candidate_cardinality_status', case
    when (select count(*) from recovery_candidate_jobs) = 2 then 'expected_two'
    when (select count(*) from recovery_candidate_jobs) = 0 then 'no_recovery_candidates'
    else 'unexpected_count'
  end,
  'canary_jobs', coalesce((
    select jsonb_agg(to_jsonb(j) order by j.created_at,j.id) from canary_jobs j
  ), '[]'::jsonb),
  'recovery_candidate_jobs', coalesce((
    select jsonb_agg(to_jsonb(j) order by j.created_at,j.id) from recovery_candidate_jobs j
  ), '[]'::jsonb),
  'lease_summary', coalesce((
    select jsonb_agg(to_jsonb(l) order by l.job_id) from lease_summary l
  ), '[]'::jsonb),
  'piece_summary', coalesce((
    select jsonb_agg(to_jsonb(p) order by p.job_id,p.pass_kind,p.article_id,p.segmentation_version) from piece_summary p
  ), '[]'::jsonb),
  'article_transcriptions', coalesce((
    select jsonb_agg(to_jsonb(t) order by t.job_id,t.pass_kind,t.article_id) from transcription_summary t
  ), '[]'::jsonb),
  'decisions', coalesce((
    select jsonb_agg(to_jsonb(d) order by d.job_id,d.article_id) from decision_rows d
  ), '[]'::jsonb),
  'canonicals', coalesce((
    select jsonb_agg(to_jsonb(v) order by v.source_consensus_job_id,v.article_id) from canonical_rows v
  ), '[]'::jsonb),
  'method_comparison_v19', coalesce((
    select jsonb_agg(to_jsonb(c)) from public.ocr_canary_method_comparison_v19 c
  ), '[]'::jsonb),
  'fidelity_v22', coalesce((
    select jsonb_agg(to_jsonb(f)) from public.ocr_canary_fidelity_v22 f
  ), '[]'::jsonb),
  'ocr_verification_gate_v2', coalesce((
    select jsonb_agg(to_jsonb(g)) from public.ocr_verification_gate_v2 g
  ), '[]'::jsonb),
  'region_provenance_quality_v19', coalesce((
    select jsonb_agg(to_jsonb(p))
    from public.ocr_region_provenance_quality_v19 p
    where p.article_id in (
      select article_id from piece_summary
      union
      select article_id from transcription_summary
      union
      select article_id from decision_rows
    )
  ), '[]'::jsonb),
  'recent_requeue_archives', coalesce((
    select jsonb_agg(to_jsonb(a)) from (select * from requeue_rows limit 10) a
  ), '[]'::jsonb),
  'recent_resume_receipts', coalesce((
    select jsonb_agg(to_jsonb(r)) from (select * from resume_rows limit 10) r
  ), '[]'::jsonb)
) as ocr_canary_recovery_readout_v23;

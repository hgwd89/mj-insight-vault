-- READ ONLY: authoritative readout for the latest explicitly registered OCR canary cohort.
-- Cohort identity comes only from ocr_consensus_canary_cohorts_v26.  Never infer the
-- release-comparison cohort from job timestamps, status ordering, or the latest two jobs.

with latest_cohort as (
  select
    c.id,
    c.job_id_1,
    c.job_id_2,
    c.restart_archive_id_1,
    c.restart_archive_id_2,
    c.reason,
    c.operation,
    c.created_at
  from public.ocr_consensus_canary_cohorts_v26 c
  order by c.created_at desc,c.id desc
  limit 1
),
cohort_job_ids as (
  select job_id_1 as job_id from latest_cohort
  union all
  select job_id_2 as job_id from latest_cohort
),
cohort_jobs as (
  select
    j.id,
    j.source_job_id,
    j.pipeline_version,
    j.article_count,
    j.is_canary,
    j.status,
    j.failure_count,
    j.lease_token is not null as has_lease_token,
    j.lease_expires_at,
    j.error_message,
    j.created_at,
    j.updated_at,
    j.finished_at
  from public.ocr_consensus_jobs_v11 j
  where j.id in (select job_id from cohort_job_ids)
),
archive_bindings as (
  select
    c.id as cohort_id,
    x.ordinal,
    x.job_id,
    x.archive_id,
    a.job_id as archived_job_id,
    a.reason as archive_reason,
    a.created_at as archive_created_at,
    (
      a.id is not null
      and a.job_id = x.job_id
      and a.reason = format('v21/v2 clean restart: %s',c.reason)
    ) as binding_valid
  from latest_cohort c
  cross join lateral (
    values
      (1,c.job_id_1,c.restart_archive_id_1),
      (2,c.job_id_2,c.restart_archive_id_2)
  ) as x(ordinal,job_id,archive_id)
  left join public.ocr_consensus_requeue_archives_v12 a on a.id = x.archive_id
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
  where r.job_id in (select job_id from cohort_job_ids)
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
  where t.job_id in (select job_id from cohort_job_ids)
),
decision_rows as (
  select d.*
  from public.ocr_consensus_decisions_v11 d
  where d.job_id in (select job_id from cohort_job_ids)
),
canonical_rows as (
  select v.*
  from public.article_ocr_verifications_v11 v
  where v.source_consensus_job_id in (select job_id from cohort_job_ids)
),
resume_rows as (
  select r.*
  from public.ocr_consensus_resume_receipts_v19 r
  where r.job_id in (select job_id from cohort_job_ids)
  order by r.created_at desc
),
cohort_status as (
  select
    count(*)::integer as job_count,
    count(*) filter (where status in ('completed','needs_review'))::integer as terminal_job_count,
    count(*) filter (where status = 'failed')::integer as failed_job_count,
    count(*) filter (where status in ('queued','running'))::integer as active_job_count,
    count(*) filter (where is_canary is distinct from true)::integer as noncanary_job_count
  from cohort_jobs
),
archive_status as (
  select
    count(*)::integer as archive_binding_count,
    count(*) filter (where binding_valid)::integer as valid_archive_binding_count,
    coalesce(bool_and(binding_valid),false) as all_archive_bindings_valid
  from archive_bindings
)
select jsonb_build_object(
  'captured_at',now(),
  'database',current_database(),
  'server_version',current_setting('server_version'),
  'latest_cohort',(select to_jsonb(c) from latest_cohort c),
  'expected_latest_cohort_job_count',2,
  'latest_cohort_job_count',(select job_count from cohort_status),
  'latest_cohort_terminal_job_count',(select terminal_job_count from cohort_status),
  'latest_cohort_failed_job_count',(select failed_job_count from cohort_status),
  'latest_cohort_active_job_count',(select active_job_count from cohort_status),
  'latest_cohort_noncanary_job_count',(select noncanary_job_count from cohort_status),
  'latest_cohort_archive_binding_count',(select archive_binding_count from archive_status),
  'latest_cohort_valid_archive_binding_count',(select valid_archive_binding_count from archive_status),
  'latest_cohort_archive_binding_valid',(select all_archive_bindings_valid from archive_status),
  'latest_cohort_ready_for_comparison',(
    (select job_count from cohort_status) = 2
    and (select terminal_job_count from cohort_status) = 2
    and (select failed_job_count from cohort_status) = 0
    and (select active_job_count from cohort_status) = 0
    and (select noncanary_job_count from cohort_status) = 0
    and (select archive_binding_count from archive_status) = 2
    and (select all_archive_bindings_valid from archive_status)
  ),
  'cohort_jobs',coalesce((
    select jsonb_agg(to_jsonb(j) order by j.id) from cohort_jobs j
  ),'[]'::jsonb),
  'archive_bindings',coalesce((
    select jsonb_agg(to_jsonb(a) order by a.ordinal) from archive_bindings a
  ),'[]'::jsonb),
  'piece_summary',coalesce((
    select jsonb_agg(to_jsonb(p) order by p.job_id,p.pass_kind,p.article_id,p.segmentation_version) from piece_summary p
  ),'[]'::jsonb),
  'article_transcriptions',coalesce((
    select jsonb_agg(to_jsonb(t) order by t.job_id,t.pass_kind,t.article_id) from transcription_summary t
  ),'[]'::jsonb),
  'decisions',coalesce((
    select jsonb_agg(to_jsonb(d) order by d.job_id,d.article_id) from decision_rows d
  ),'[]'::jsonb),
  'canonicals',coalesce((
    select jsonb_agg(to_jsonb(v) order by v.source_consensus_job_id,v.article_id) from canonical_rows v
  ),'[]'::jsonb),
  'method_comparison_v19',coalesce((
    select jsonb_agg(to_jsonb(c))
    from public.ocr_canary_method_comparison_v19 c
    where c.consensus_job_id in (select job_id from cohort_job_ids)
  ),'[]'::jsonb),
  'fidelity_v22',coalesce((
    select jsonb_agg(to_jsonb(f))
    from public.ocr_canary_fidelity_v22 f
    where f.consensus_job_id in (select job_id from cohort_job_ids)
  ),'[]'::jsonb),
  'region_provenance_quality_v19',coalesce((
    select jsonb_agg(to_jsonb(p))
    from public.ocr_region_provenance_quality_v19 p
    where p.article_id in (
      select article_id from piece_summary
      union
      select article_id from transcription_summary
      union
      select article_id from decision_rows
    )
  ),'[]'::jsonb),
  'recent_resume_receipts',coalesce((
    select jsonb_agg(to_jsonb(r)) from (select * from resume_rows limit 10) r
  ),'[]'::jsonb),
  'method_comparison_v19_all_marked',coalesce((
    select jsonb_agg(to_jsonb(c)) from public.ocr_canary_method_comparison_v19 c
  ),'[]'::jsonb),
  'fidelity_v22_all_marked',coalesce((
    select jsonb_agg(to_jsonb(f)) from public.ocr_canary_fidelity_v22 f
  ),'[]'::jsonb),
  'ocr_verification_gate_v2',coalesce((
    select jsonb_agg(to_jsonb(g)) from public.ocr_verification_gate_v2 g
  ),'[]'::jsonb)
) as ocr_canary_cohort_readout_v26;

create or replace view public.aaaa_pipeline_readiness_v7
with (security_invoker=true)
as
with base as (
  select * from public.aaaa_pipeline_readiness_v6
), valid_scans as (
  select count(*)::integer valid_scan_count
  from public.full_corpus_scan_runs r
  where public.full_corpus_run_integrity_v5(r.id)
), valid_themes as (
  select count(*)::integer valid_theme_proof_count
  from public.theme_analysis_runs_v4 a
  where public.theme_analysis_proof_integrity_v6(a.id)
), report_jobs as (
  select
    count(*)::integer total_report_jobs_v6,
    count(*) filter(where status='queued')::integer queued_report_jobs_v6,
    count(*) filter(where status='running')::integer running_report_jobs_v6,
    count(*) filter(where status='needs_review')::integer review_report_jobs_v6,
    count(*) filter(where status='completed')::integer completed_report_jobs_v6,
    count(*) filter(where status='published')::integer published_report_jobs_v6,
    count(*) filter(where status='failed')::integer failed_report_jobs_v6
  from public.formal_report_jobs_v6
), reports as (
  select count(*)::integer formal_v6_report_count
  from public.chat_reports
  where is_formal_report
    and answer_json->>'formal_gate_version'='formal_report_v6_claim_graph'
    and exists(
      select 1 from public.formal_report_jobs_v6 j
      where j.report_id=chat_reports.id and j.status='published' and public.formal_report_integrity_v6(j.id)
    )
)
select
  b.formal_article_count,b.source_capture_count,b.source_page_identity_count,b.page_identity_gate,
  b.formal_corpus_freeze_gate,b.formal_corpus_freeze_reason,
  b.source_grounded_article_count,b.missing_or_invalid_source_region_count,b.partition_complete_page_identity_count,
  b.source_region_gate,b.source_region_gate_reason,
  b.total_partition_jobs,b.queued_partition_jobs,b.running_partition_jobs,b.review_partition_jobs,b.completed_partition_jobs,b.failed_partition_jobs,
  b.pages_needing_secondary_grounding,b.articles_needing_secondary_grounding,
  b.strict_embedding_count,b.embedding_gate,b.embedding_gate_reason,
  b.duplicate_audit_run_id,b.duplicate_candidate_pair_count,b.reviewed_distinct_pair_count,b.reviewed_duplicate_pair_count,b.unresolved_pair_count,b.duplicate_gate,b.duplicate_gate_reason,
  b.profiled_article_count,b.categorized_article_count,b.no_matching_category_count,b.invalid_profile_count,b.category_needs_review_job_count,b.category_classification_gate,b.category_gate_reason,
  b.total_classification_jobs,b.queued_classification_jobs,b.running_classification_jobs,b.review_classification_jobs,b.completed_classification_jobs,b.failed_classification_jobs,
  s.valid_scan_count,t.valid_theme_proof_count,
  rj.total_report_jobs_v6,rj.queued_report_jobs_v6,rj.running_report_jobs_v6,rj.review_report_jobs_v6,rj.completed_report_jobs_v6,rj.published_report_jobs_v6,rj.failed_report_jobs_v6,
  rp.formal_v6_report_count,
  case
    when b.formal_article_count=0 then 'formal_corpus_empty'
    when b.page_identity_gate<>'passed' then 'page_identity_gate_failed'
    when b.formal_corpus_freeze_gate<>'passed' then 'formal_corpus_freeze_failed'
    when b.source_region_gate<>'passed' then 'source_region_mapping_required'
    when b.embedding_gate<>'passed' then 'source_grounded_embedding_required'
    when b.duplicate_gate<>'passed' then 'source_grounded_duplicate_audit_required'
    when b.category_classification_gate<>'passed' then 'source_grounded_category_classification_required'
    when s.valid_scan_count=0 then 'dual_pass_full_corpus_review_required'
    when t.valid_theme_proof_count=0 then 'dual_pass_theme_census_and_seal_required'
    else 'ready_for_strict_v6_report_generation'
  end readiness_status
from base b cross join valid_scans s cross join valid_themes t cross join report_jobs rj cross join reports rp;

revoke all on public.aaaa_pipeline_readiness_v7 from public,anon,authenticated;
grant select on public.aaaa_pipeline_readiness_v7 to service_role;
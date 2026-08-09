create view public.aaaa_pipeline_readiness_v6 as
with fs as (select * from public.formal_corpus_freeze_snapshot_v1()),
fg as (select * from public.formal_corpus_freeze_gate_v2),
identity_gate as (select * from public.formal_source_page_identity_gate_v1),
source_region as (select * from public.article_source_region_gate_v4),
partition_jobs as (
  select count(*)::int total_partition_jobs,
         count(*) filter(where status='queued')::int queued_partition_jobs,
         count(*) filter(where status='running')::int running_partition_jobs,
         count(*) filter(where status='needs_review')::int review_partition_jobs,
         count(*) filter(where status='completed')::int completed_partition_jobs,
         count(*) filter(where status='failed')::int failed_partition_jobs
  from public.source_page_partition_jobs_v3
),
secondary as (
  select count(*) filter(where headline_ge020_count<article_count)::int pages_needing_secondary_grounding,
         sum(article_count-headline_ge020_count)::int articles_needing_secondary_grounding
  from public.source_page_primary_capture_v1
),
embedding as (select * from public.article_embedding_quality_gate_v4),
dup as (select * from public.formal_corpus_duplicate_gate_v5),
class_gate as (select * from public.category_classification_gate_v4),
class_jobs as (
  select count(*)::int total_classification_jobs,
         count(*) filter(where status='queued')::int queued_classification_jobs,
         count(*) filter(where status='running')::int running_classification_jobs,
         count(*) filter(where status='needs_review')::int review_classification_jobs,
         count(*) filter(where status='completed')::int completed_classification_jobs,
         count(*) filter(where status='failed')::int failed_classification_jobs
  from public.article_classification_jobs_v4
),
scan as (
  select count(*) filter(where scope_type='all' and coalesce(scope_query,'')='' and analysis_contract_version='strict_report_v4_source_census' and coalesce(coverage_json->>'prompt_version','')='full_corpus_batch_v4_source_grounded_article_reviews' and status='completed')::int completed_v4_scan_runs
  from public.full_corpus_scan_runs
),
theme as (
  select count(*) filter(where status='completed')::int completed_theme_runs_v4 from public.theme_analysis_runs_v4
),
reports as (
  select count(*) filter(where is_formal_report)::int formal_report_count from public.chat_reports
)
select
  fs.article_count formal_article_count,
  fs.source_capture_count,
  fs.source_page_identity_count,
  ig.page_identity_gate,
  fg.freeze_gate_v2 formal_corpus_freeze_gate,
  fg.gate_reason_v2 formal_corpus_freeze_reason,
  sr.source_grounded_article_count,
  sr.missing_or_invalid_source_region_count,
  sr.partition_complete_page_identity_count,
  sr.source_region_gate,
  sr.gate_reason source_region_gate_reason,
  pj.total_partition_jobs,pj.queued_partition_jobs,pj.running_partition_jobs,pj.review_partition_jobs,pj.completed_partition_jobs,pj.failed_partition_jobs,
  sec.pages_needing_secondary_grounding,sec.articles_needing_secondary_grounding,
  emb.strict_embedding_count,
  emb.embedding_gate,
  emb.gate_reason embedding_gate_reason,
  dup.audit_run_id duplicate_audit_run_id,
  dup.duplicate_candidate_pair_count,
  dup.reviewed_distinct_pair_count,
  dup.reviewed_duplicate_pair_count,
  dup.unresolved_pair_count,
  dup.duplicate_gate,
  dup.gate_reason duplicate_gate_reason,
  cg.profiled_article_count,
  cg.categorized_article_count,
  cg.no_matching_category_count,
  cg.invalid_profile_count,
  cg.needs_review_job_count category_needs_review_job_count,
  cg.category_classification_gate,
  cg.gate_reason category_gate_reason,
  cj.total_classification_jobs,cj.queued_classification_jobs,cj.running_classification_jobs,cj.review_classification_jobs,cj.completed_classification_jobs,cj.failed_classification_jobs,
  sc.completed_v4_scan_runs,
  th.completed_theme_runs_v4,
  rp.formal_report_count,
  case
    when fs.article_count=0 then 'formal_corpus_empty'
    when ig.page_identity_gate<>'passed' then 'page_identity_gate_failed'
    when fg.freeze_gate_v2<>'passed' then 'formal_corpus_freeze_v2_failed'
    when sr.source_region_gate<>'passed' then 'source_region_mapping_required'
    when emb.embedding_gate<>'passed' then 'source_grounded_embedding_required'
    when dup.duplicate_gate<>'passed' then 'source_grounded_duplicate_audit_required'
    when cg.category_classification_gate<>'passed' then 'source_grounded_category_classification_required'
    when sc.completed_v4_scan_runs=0 then 'v4_source_grounded_article_review_scan_required'
    when th.completed_theme_runs_v4=0 then 'v4_full_theme_census_required'
    else 'ready_for_strict_report_generation'
  end readiness_status
from fs
cross join identity_gate ig
cross join fg
cross join source_region sr
cross join partition_jobs pj
cross join secondary sec
cross join embedding emb
cross join dup
cross join class_gate cg
cross join class_jobs cj
cross join scan sc
cross join theme th
cross join reports rp;

revoke all on table public.aaaa_pipeline_readiness_v6 from anon,authenticated;
grant select on table public.aaaa_pipeline_readiness_v6 to service_role;
create view public.aaaa_pipeline_readiness_v4 as
with fs as (select * from public.formal_corpus_freeze_snapshot_v1()),
identity_gate as (select * from public.formal_source_page_identity_gate_v1),
freeze_gate as (select * from public.formal_corpus_freeze_gate_v1),
primary_capture as (
  select count(*)::int primary_capture_count,count(*) filter(where selection_status='needs_secondary_grounding')::int pages_needing_secondary_grounding,count(*) filter(where freeze_receipt_id is distinct from (select freeze_receipt_id from public.formal_corpus_freeze_gate_v1))::int stale_primary_capture_count from public.source_page_primary_capture_v1
),
source_region as (select * from public.article_source_region_gate_v3),
partition_jobs as (select count(*)::int total_partition_jobs,count(*) filter(where status='queued')::int queued_partition_jobs,count(*) filter(where status='running')::int running_partition_jobs,count(*) filter(where status='needs_review')::int review_partition_jobs,count(*) filter(where status='completed')::int completed_partition_jobs,count(*) filter(where status='failed')::int failed_partition_jobs from public.source_page_partition_jobs_v3),
embedding as (select * from public.article_embedding_quality_gate_v2),
dup_gate as (select * from public.formal_corpus_duplicate_gate_v4),
category_gate as (select * from public.category_classification_gate_v3),
scans as (select count(*) filter(where scope_type='all' and scope_query is null and coalesce(coverage_json->>'prompt_version','')='full_corpus_batch_v4_source_grounded_article_reviews')::int v4_scan_run_count from public.full_corpus_scan_runs),
themes as (select count(*) filter(where status='completed')::int completed_theme_runs from public.theme_analysis_runs_v4),
reports as (select count(*) filter(where is_formal_report)::int formal_report_count from public.chat_reports)
select fs.article_count formal_article_count,fs.source_capture_count,fs.source_page_identity_count,ig.page_identity_gate,fg.freeze_gate,fg.gate_reason freeze_gate_reason,pc.primary_capture_count,pc.pages_needing_secondary_grounding,pc.stale_primary_capture_count,sr.source_grounded_article_count,sr.missing_or_invalid_source_region_count,sr.partition_complete_page_identity_count,sr.source_region_gate,sr.gate_reason source_region_gate_reason,pj.total_partition_jobs,pj.queued_partition_jobs,pj.running_partition_jobs,pj.review_partition_jobs,pj.completed_partition_jobs,pj.failed_partition_jobs,e.strict_embedding_count,e.embedding_gate,e.gate_reason embedding_gate_reason,dg.duplicate_gate,dg.gate_reason duplicate_gate_reason,cg.categorized_article_count,cg.category_classification_gate,cg.gate_reason category_gate_reason,s.v4_scan_run_count,t.completed_theme_runs,r.formal_report_count,
case
  when fs.article_count=0 then 'formal_corpus_empty'
  when ig.page_identity_gate<>'passed' then 'page_identity_gate_failed'
  when fg.freeze_gate<>'passed' then 'formal_corpus_freeze_stale'
  when pc.primary_capture_count<>fs.source_page_identity_count or pc.stale_primary_capture_count>0 then 'primary_capture_selection_stale'
  when sr.source_region_gate<>'passed' then 'source_region_v3_mapping_required'
  when e.embedding_gate<>'passed' then 'strict_clean_embedding_rebuild_required'
  when dg.duplicate_gate<>'passed' then 'strict_duplicate_audit_required'
  when cg.category_classification_gate<>'passed' then 'strict_clean_category_classification_required'
  when s.v4_scan_run_count=0 then 'v4_source_grounded_scan_required'
  when t.completed_theme_runs=0 then 'v4_theme_census_required'
  else 'ready_for_v4_report_proof'
end readiness_status
from fs cross join identity_gate ig cross join freeze_gate fg cross join primary_capture pc cross join source_region sr cross join partition_jobs pj cross join embedding e cross join dup_gate dg cross join category_gate cg cross join scans s cross join themes t cross join reports r;
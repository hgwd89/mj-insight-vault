create or replace view public.aaaa_pipeline_readiness_v3 as
with formal_stats as (
  select count(*)::integer formal_article_count,
         count(distinct f.source_image_id)::integer source_page_count,
         count(*) filter(where coalesce(a.analysis_body_clean,'')<>'')::integer clean_body_count,
         count(*) filter(where coalesce(a.analysis_body_clean_sha256,'')~'^[0-9a-f]{64}$')::integer clean_body_hash_count,
         count(*) filter(where coalesce(f.source_ocr_sha256,'')~'^[0-9a-f]{64}$')::integer source_ocr_hash_count,
         count(*) filter(where coalesce(s.ocr_text_raw,'')='')::integer missing_raw_ocr_count
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  join public.source_images s on s.id=f.source_image_id
), proof as (
  select article_count::integer proof_article_count,source_truth_fingerprint
  from public.formal_corpus_scope_proof_v3('all','')
), source_region as (
  select * from public.article_source_region_gate_v2
), embedding as (
  select * from public.article_embedding_quality_gate_v2
), duplicate_gate as (
  select * from public.formal_corpus_duplicate_gate_v4
), category_gate as (
  select * from public.category_classification_gate_v3
), scans as (
  select count(*) filter(where scope_type='all' and scope_query is null and coalesce(coverage_json->>'prompt_version','')='full_corpus_batch_v4_source_grounded_article_reviews')::integer v4_scan_run_count,
         count(*) filter(where status in ('queued','running') and scope_type='all' and scope_query is null and coalesce(coverage_json->>'prompt_version','')='full_corpus_batch_v4_source_grounded_article_reviews')::integer active_v4_scan_runs
  from public.full_corpus_scan_runs
), themes as (
  select count(*)::integer theme_analysis_run_count,
         count(*) filter(where status in ('queued','running'))::integer active_theme_analysis_runs,
         count(*) filter(where status='completed')::integer completed_theme_analysis_runs
  from public.theme_analysis_runs_v4
), reports as (
  select count(*) filter(where is_formal_report)::integer formal_report_count,
         count(*) filter(where not is_formal_report)::integer provisional_report_count
  from public.chat_reports
), jobs as (
  select count(*) filter(where status in ('queued','running') and coalesce(request_json->>'pipeline_version','') like 'report_pipeline_v4%')::integer active_v4_report_jobs,
         count(*) filter(where status in ('queued','running') and coalesce(request_json->>'pipeline_version','')='report_pipeline_v3')::integer active_legacy_v3_report_jobs
  from public.chat_jobs
), rollups as (
  select count(*) filter(where integrity_ok)::integer valid_monthly_rollups,
         count(*) filter(where not integrity_ok)::integer invalid_monthly_rollups
  from public.monthly_rollup_gate_v3
), legacy_cron as (
  select count(*) filter(where active and command='select public.kick_active_v2_corpus_scan_v1();')::integer active_legacy_v2_scan_cron
  from cron.job
)
select fs.formal_article_count,fs.source_page_count,fs.clean_body_count,fs.clean_body_hash_count,
       fs.source_ocr_hash_count,fs.missing_raw_ocr_count,p.source_truth_fingerprint,
       sr.source_grounded_article_count,sr.missing_or_invalid_source_region_count,
       sr.partition_complete_source_page_count,sr.source_region_gate,sr.gate_reason source_region_gate_reason,
       e.any_embedding_count,e.legacy_embedding_count,e.page_ocr_contaminated_count,e.strict_embedding_count,
       e.embedding_gate,e.gate_reason embedding_gate_reason,
       d.audit_run_id duplicate_audit_run_id,d.audit_run_status duplicate_audit_run_status,
       d.duplicate_candidate_pair_count,d.reviewed_duplicate_pair_count,d.unresolved_pair_count,
       d.duplicate_gate,d.gate_reason duplicate_gate_reason,
       c.profiled_article_count,c.categorized_article_count,c.unprofiled_article_count,c.uncategorized_article_count,
       c.category_classification_gate,c.gate_reason category_gate_reason,
       s.v4_scan_run_count,s.active_v4_scan_runs,t.theme_analysis_run_count,t.active_theme_analysis_runs,t.completed_theme_analysis_runs,
       r.formal_report_count,r.provisional_report_count,j.active_v4_report_jobs,j.active_legacy_v3_report_jobs,
       ro.valid_monthly_rollups,ro.invalid_monthly_rollups,lc.active_legacy_v2_scan_cron,
       case
         when fs.formal_article_count=0 then 'formal_corpus_empty'
         when p.proof_article_count<>fs.formal_article_count then 'formal_corpus_proof_count_mismatch'
         when fs.missing_raw_ocr_count>0 or fs.source_ocr_hash_count<>fs.formal_article_count then 'raw_source_ocr_incomplete'
         when fs.clean_body_count<>fs.formal_article_count or fs.clean_body_hash_count<>fs.formal_article_count then 'clean_analysis_body_incomplete'
         when sr.source_region_gate<>'passed' then 'source_region_mapping_required'
         when e.embedding_gate<>'passed' then 'strict_clean_embedding_rebuild_required'
         when d.duplicate_gate<>'passed' then 'strict_duplicate_audit_required'
         when c.category_classification_gate<>'passed' then 'strict_clean_category_classification_required'
         when s.v4_scan_run_count=0 then 'v4_source_grounded_scan_required'
         when t.completed_theme_analysis_runs=0 then 'v4_theme_census_required'
         else 'ready_for_v4_report_proof'
       end readiness_status
from formal_stats fs cross join proof p cross join source_region sr cross join embedding e cross join duplicate_gate d cross join category_gate c cross join scans s cross join themes t cross join reports r cross join jobs j cross join rollups ro cross join legacy_cron lc;
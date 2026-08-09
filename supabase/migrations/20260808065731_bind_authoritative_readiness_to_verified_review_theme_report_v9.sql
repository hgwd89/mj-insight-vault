begin;
create or replace view public.aaaa_pipeline_readiness_v8
with (security_invoker=true)
as
select r.formal_article_count,r.source_capture_count,r.source_page_identity_count,r.page_identity_gate,r.formal_corpus_freeze_gate,r.formal_corpus_freeze_reason,
       sr.source_grounded_article_count,greatest(sr.expected_article_count-sr.source_grounded_article_count,0) missing_or_invalid_source_region_count,
       sr.source_grounded_page_count partition_complete_page_identity_count,sr.source_region_gate,sr.source_region_gate_reason,sr.job_count total_partition_jobs,
       0 queued_partition_jobs,0 running_partition_jobs,0 review_partition_jobs,sr.completed_jobs completed_partition_jobs,0 failed_partition_jobs,0 pages_needing_secondary_grounding,0 articles_needing_secondary_grounding,
       eg.strict_embedding_count,eg.embedding_gate,eg.gate_reason embedding_gate_reason,
       dg.audit_run_id duplicate_audit_run_id,coalesce(dg.candidate_pair_count,0) duplicate_candidate_pair_count,coalesce(dg.reviewed_distinct_pair_count,0) reviewed_distinct_pair_count,
       coalesce(dg.reviewed_duplicate_pair_count,0) reviewed_duplicate_pair_count,coalesce(dg.unresolved_pair_count,0) unresolved_pair_count,dg.duplicate_gate,dg.gate_reason duplicate_gate_reason,
       cg.profiled_article_count,cg.categorized_article_count,cg.no_matching_category_count,0::integer invalid_profile_count,cg.review_jobs category_needs_review_job_count,
       cg.category_classification_gate,cg.gate_reason category_gate_reason,cg.total_jobs total_classification_jobs,cg.queued_jobs queued_classification_jobs,cg.running_jobs running_classification_jobs,
       cg.review_jobs review_classification_jobs,cg.completed_jobs completed_classification_jobs,cg.failed_jobs failed_classification_jobs,
       case when ar.review_gate='passed' then 1 else 0 end::integer valid_scan_count,
       case when ta.analysis_gate='passed' then 1 else 0 end::integer valid_theme_proof_count,
       case when tr.report_run_id is null then 0 else 1 end::integer total_report_jobs_v6,
       0::integer queued_report_jobs_v6,
       case when tr.report_run_status in ('notes','finalizing') then 1 else 0 end::integer running_report_jobs_v6,
       case when tr.report_run_status='needs_review' then 1 else 0 end::integer review_report_jobs_v6,
       case when tr.report_run_status='completed' then 1 else 0 end::integer completed_report_jobs_v6,
       case when tr.report_gate='passed' then 1 else 0 end::integer published_report_jobs_v6,
       case when tr.report_run_status='failed' then 1 else 0 end::integer failed_report_jobs_v6,
       coalesce(tr.report_count,0)::integer formal_v6_report_count,
       r.readiness_status,
       s.active_legacy_cron_count,s.orphan_legacy_active_job_count,s.legacy_formal_report_count,s.invalid_v6_formal_report_count,s.externally_executable_security_definer_count,s.strict_rls_disabled_table_count,s.strict_external_dml_grant_count,s.system_safety_gate,
       case when s.system_safety_gate<>'passed' then 'system_safety_gate_failed'
            when oq.ocr_quality_gate<>'passed' then 'ocr_quality_backfill_or_staleness_failed'
            when ip.provenance_gate<>'passed' then 'source_image_provenance_failed'
            when inv.inventory_gate='discovery_required' then 'new_articles_discovered_refreeze_required'
            when inv.inventory_gate<>'passed' then 'article_inventory_required'
            when sr.source_region_gate<>'passed' then 'source_region_materialization_required'
            when og.ocr_verification_gate='failed' then 'article_ocr_verification_failed'
            when og.ocr_verification_gate<>'passed' then 'article_ocr_verification_required'
            when eg.embedding_gate<>'passed' then 'verified_text_embedding_required'
            when dg.duplicate_gate<>'passed' then 'verified_text_duplicate_audit_required'
            when cg.category_classification_gate<>'passed' then 'verified_text_category_classification_required'
            when ar.review_gate<>'passed' then 'verified_article_review_required'
            when tc.candidate_gate<>'passed' then 'verified_theme_candidate_discovery_required'
            when tcen.census_gate<>'passed' then 'verified_theme_census_required'
            when ta.analysis_gate<>'passed' then 'verified_theme_analysis_proof_required'
            when tr.report_gate<>'passed' then 'verified_theme_report_required'
            else 'ready' end readiness_status_v8,
       oq.ocr_quality_gate,oq.expected_block_count,oq.quality_block_count,oq.missing_quality_count,oq.stale_quality_count,
       ip.provenance_gate,ip.legacy_derivative_sources,ip.original_preserved_sources,
       inv.inventory_gate,inv.pages inventory_pages,inv.jobs inventory_jobs,inv.completed completed_inventory_jobs,inv.discovery_required inventory_discovery_required,inv.needs_review inventory_needs_review,
       og.ocr_verification_gate ocr_readiness_gate,ov.strong_region_count,ov.review_region_count,ov.low_region_count,og.verified::bigint verified_article_count
from public.aaaa_pipeline_readiness_v7 r
cross join public.strict_system_safety_audit_v1 s
cross join public.source_ocr_quality_gate_v2 oq
cross join public.source_image_ingest_provenance_gate_v3 ip
cross join public.source_page_article_inventory_gate_v1 inv
cross join public.source_region_inventory_gate_v6 sr
cross join public.aaaa_ocr_readiness_v1 ov
cross join public.ocr_verification_gate_v2 og
cross join public.article_embedding_quality_gate_v5 eg
cross join public.source_grounded_duplicate_gate_v6 dg
cross join public.article_classification_quality_gate_v6 cg
cross join public.verified_article_review_gate_v6 ar
cross join public.verified_theme_candidate_gate_v7 tc
cross join public.verified_theme_census_gate_v7 tcen
cross join public.verified_theme_analysis_gate_v8 ta
cross join public.verified_theme_report_gate_v8 tr;
commit;
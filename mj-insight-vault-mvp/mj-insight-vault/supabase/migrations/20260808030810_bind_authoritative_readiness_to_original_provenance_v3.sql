begin;

create or replace view public.aaaa_pipeline_readiness_v8
with (security_invoker=true)
as
select
    r.formal_article_count,
    r.source_capture_count,
    r.source_page_identity_count,
    r.page_identity_gate,
    r.formal_corpus_freeze_gate,
    r.formal_corpus_freeze_reason,
    r.source_grounded_article_count,
    r.missing_or_invalid_source_region_count,
    r.partition_complete_page_identity_count,
    r.source_region_gate,
    r.source_region_gate_reason,
    r.total_partition_jobs,
    r.queued_partition_jobs,
    r.running_partition_jobs,
    r.review_partition_jobs,
    r.completed_partition_jobs,
    r.failed_partition_jobs,
    r.pages_needing_secondary_grounding,
    r.articles_needing_secondary_grounding,
    r.strict_embedding_count,
    r.embedding_gate,
    r.embedding_gate_reason,
    r.duplicate_audit_run_id,
    r.duplicate_candidate_pair_count,
    r.reviewed_distinct_pair_count,
    r.reviewed_duplicate_pair_count,
    r.unresolved_pair_count,
    r.duplicate_gate,
    r.duplicate_gate_reason,
    r.profiled_article_count,
    r.categorized_article_count,
    r.no_matching_category_count,
    r.invalid_profile_count,
    r.category_needs_review_job_count,
    r.category_classification_gate,
    r.category_gate_reason,
    r.total_classification_jobs,
    r.queued_classification_jobs,
    r.running_classification_jobs,
    r.review_classification_jobs,
    r.completed_classification_jobs,
    r.failed_classification_jobs,
    r.valid_scan_count,
    r.valid_theme_proof_count,
    r.total_report_jobs_v6,
    r.queued_report_jobs_v6,
    r.running_report_jobs_v6,
    r.review_report_jobs_v6,
    r.completed_report_jobs_v6,
    r.published_report_jobs_v6,
    r.failed_report_jobs_v6,
    r.formal_v6_report_count,
    r.readiness_status,
    s.active_legacy_cron_count,
    s.orphan_legacy_active_job_count,
    s.legacy_formal_report_count,
    s.invalid_v6_formal_report_count,
    s.externally_executable_security_definer_count,
    s.strict_rls_disabled_table_count,
    s.strict_external_dml_grant_count,
    s.system_safety_gate,
    case
      when s.system_safety_gate<>'passed' then 'system_safety_gate_failed'
      when oq.ocr_quality_gate<>'passed' then 'ocr_quality_backfill_or_staleness_failed'
      when ip.provenance_gate<>'passed' then 'source_image_provenance_failed'
      when inv.inventory_gate='discovery_required' then 'new_articles_discovered_refreeze_required'
      when inv.inventory_gate<>'passed' then 'article_inventory_required'
      when r.source_region_gate<>'passed' then 'source_region_mapping_required'
      when ov.ocr_readiness_gate<>'passed' then 'article_ocr_verification_required'
      when r.embedding_gate<>'passed' then 'verified_text_embedding_required'
      when r.duplicate_gate<>'passed' then 'verified_text_duplicate_audit_required'
      when r.category_classification_gate<>'passed' then 'verified_text_category_classification_required'
      else r.readiness_status
    end as readiness_status_v8,
    oq.ocr_quality_gate,
    oq.expected_block_count,
    oq.quality_block_count,
    oq.missing_quality_count,
    oq.stale_quality_count,
    ip.provenance_gate,
    ip.legacy_derivative_sources,
    ip.original_preserved_sources,
    inv.inventory_gate,
    inv.pages as inventory_pages,
    inv.jobs as inventory_jobs,
    inv.completed as completed_inventory_jobs,
    inv.discovery_required as inventory_discovery_required,
    inv.needs_review as inventory_needs_review,
    ov.ocr_readiness_gate,
    ov.strong_region_count,
    ov.review_region_count,
    ov.low_region_count,
    ov.verified_article_count
from public.aaaa_pipeline_readiness_v7 r
cross join public.strict_system_safety_audit_v1 s
cross join public.source_ocr_quality_gate_v2 oq
cross join public.source_image_ingest_provenance_gate_v3 ip
cross join public.source_page_article_inventory_gate_v1 inv
cross join public.aaaa_ocr_readiness_v1 ov;

commit;

create or replace function public.pipeline_readiness_json_v10()
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  r record;s record;oq record;ip record;inv record;sr record;ov record;og record;eg record;dg record;cg record;ar record;tc record;tcen record;ta record;tr record;
  v_status text;
begin
  select * into r from public.aaaa_pipeline_readiness_v7;
  select * into s from public.strict_system_safety_audit_v1;
  select * into oq from public.source_ocr_quality_gate_v2;
  select * into ip from public.source_image_ingest_provenance_gate_v3;
  select * into inv from public.source_page_article_inventory_gate_v1;
  select * into sr from public.source_region_inventory_gate_v6;
  select * into ov from public.aaaa_ocr_readiness_v1;
  select * into og from public.ocr_verification_gate_v2;
  select * into eg from public.article_embedding_quality_gate_v5;
  select * into dg from public.source_grounded_duplicate_gate_v6;
  select * into cg from public.article_classification_quality_gate_v6;
  select * into ar from public.verified_article_review_gate_v6;
  select * into tc from public.verified_theme_candidate_gate_v7;
  select * into tcen from public.verified_theme_census_gate_v7;
  select * into ta from public.verified_theme_analysis_gate_v8;
  select * into tr from public.verified_theme_report_gate_v8;
  v_status:=case
    when s.system_safety_gate<>'passed' then 'system_safety_gate_failed'
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
    else 'ready' end;
  return jsonb_build_object(
    'formal_article_count',r.formal_article_count,'source_capture_count',r.source_capture_count,'source_page_identity_count',r.source_page_identity_count,
    'page_identity_gate',r.page_identity_gate,'formal_corpus_freeze_gate',r.formal_corpus_freeze_gate,'formal_corpus_freeze_reason',r.formal_corpus_freeze_reason,
    'source_grounded_article_count',sr.source_grounded_article_count,'missing_or_invalid_source_region_count',greatest(sr.expected_article_count-sr.source_grounded_article_count,0),
    'partition_complete_page_identity_count',sr.source_grounded_page_count,'source_region_gate',sr.source_region_gate,'source_region_gate_reason',sr.source_region_gate_reason,
    'total_partition_jobs',sr.job_count,'queued_partition_jobs',0,'running_partition_jobs',0,'review_partition_jobs',0,'completed_partition_jobs',sr.completed_jobs,'failed_partition_jobs',0,
    'pages_needing_secondary_grounding',0,'articles_needing_secondary_grounding',0,'strict_embedding_count',eg.strict_embedding_count,'embedding_gate',eg.embedding_gate,'embedding_gate_reason',eg.gate_reason,
    'duplicate_audit_run_id',dg.audit_run_id,'duplicate_candidate_pair_count',coalesce(dg.candidate_pair_count,0),'reviewed_distinct_pair_count',coalesce(dg.reviewed_distinct_pair_count,0),
    'reviewed_duplicate_pair_count',coalesce(dg.reviewed_duplicate_pair_count,0),'unresolved_pair_count',coalesce(dg.unresolved_pair_count,0),'duplicate_gate',dg.duplicate_gate,'duplicate_gate_reason',dg.gate_reason,
    'profiled_article_count',cg.profiled_article_count,'categorized_article_count',cg.categorized_article_count,'no_matching_category_count',cg.no_matching_category_count,'invalid_profile_count',0,
    'category_needs_review_job_count',cg.review_jobs,'category_classification_gate',cg.category_classification_gate,'category_gate_reason',cg.gate_reason,
    'total_classification_jobs',cg.total_jobs,'queued_classification_jobs',cg.queued_jobs,'running_classification_jobs',cg.running_jobs,'review_classification_jobs',cg.review_jobs,'completed_classification_jobs',cg.completed_jobs,'failed_classification_jobs',cg.failed_jobs,
    'valid_scan_count',case when ar.review_gate='passed' then 1 else 0 end,'valid_theme_proof_count',case when ta.analysis_gate='passed' then 1 else 0 end,
    'total_report_jobs_v6',case when tr.report_run_id is null then 0 else 1 end,'queued_report_jobs_v6',0,'running_report_jobs_v6',case when tr.report_run_status in ('notes','finalizing') then 1 else 0 end,
    'review_report_jobs_v6',case when tr.report_run_status='needs_review' then 1 else 0 end,'completed_report_jobs_v6',case when tr.report_run_status='completed' then 1 else 0 end,
    'published_report_jobs_v6',case when tr.report_gate='passed' then 1 else 0 end,'failed_report_jobs_v6',case when tr.report_run_status='failed' then 1 else 0 end,'formal_v6_report_count',coalesce(tr.report_count,0),
    'readiness_status',r.readiness_status,'active_legacy_cron_count',s.active_legacy_cron_count,'orphan_legacy_active_job_count',s.orphan_legacy_active_job_count,'legacy_formal_report_count',s.legacy_formal_report_count,
    'invalid_v6_formal_report_count',s.invalid_v6_formal_report_count,'externally_executable_security_definer_count',s.externally_executable_security_definer_count,'strict_rls_disabled_table_count',s.strict_rls_disabled_table_count,
    'strict_external_dml_grant_count',s.strict_external_dml_grant_count,'system_safety_gate',s.system_safety_gate,'readiness_status_v8',v_status,
    'ocr_quality_gate',oq.ocr_quality_gate,'expected_block_count',oq.expected_block_count,'quality_block_count',oq.quality_block_count,'missing_quality_count',oq.missing_quality_count,'stale_quality_count',oq.stale_quality_count,
    'provenance_gate',ip.provenance_gate,'legacy_derivative_sources',ip.legacy_derivative_sources,'original_preserved_sources',ip.original_preserved_sources,
    'inventory_gate',inv.inventory_gate,'inventory_pages',inv.pages,'inventory_jobs',inv.jobs,'completed_inventory_jobs',inv.completed,'inventory_discovery_required',inv.discovery_required,'inventory_needs_review',inv.needs_review,
    'ocr_readiness_gate',og.ocr_verification_gate,'strong_region_count',ov.strong_region_count,'review_region_count',ov.review_region_count,'low_region_count',ov.low_region_count,'verified_article_count',og.verified
  );
end
$function$;
revoke all on function public.pipeline_readiness_json_v10() from public,anon,authenticated;
grant execute on function public.pipeline_readiness_json_v10() to service_role;
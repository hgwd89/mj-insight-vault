create or replace view public.aaaa_pipeline_goal_readiness_v1 as
select
  r.formal_article_count,
  r.source_page_identity_count as expected_pages,
  pr.jobs as page_recovery_jobs,
  pr.completed as page_recovery_completed,
  pr.needs_review as page_recovery_needs_review,
  pr.failed as page_recovery_failed,
  pr.binary_receipts as page_binary_receipts,
  pr.passed_receipts as page_recovery_receipts,
  pr.recovered_candidates as page_recovered_missing_candidates,
  pr.recovery_gate as page_ocr_recovery_gate,
  pr.gate_reason as page_ocr_recovery_reason,
  r.inventory_pages,
  r.inventory_jobs,
  r.completed_inventory_jobs,
  r.inventory_needs_review,
  r.inventory_discovery_required,
  r.inventory_gate,
  o.expected_articles as ocr_expected_articles,
  o.verified as ocr_verified_articles,
  o.completed as ocr_completed_pages,
  o.needs_review as ocr_needs_review_pages,
  o.failed as ocr_failed_pages,
  o.ocr_verification_gate,
  r.formal_corpus_freeze_gate,
  r.valid_scan_count,
  r.valid_theme_proof_count,
  r.formal_v6_report_count,
  r.system_safety_gate,
  case
    when r.system_safety_gate <> 'passed' then 'system_safety_required'
    when pr.recovery_gate <> 'passed' then 'page_ocr_recovery_required'
    when r.inventory_gate <> 'passed' then 'article_inventory_required'
    when o.ocr_verification_gate <> 'passed' then 'article_ocr_verification_required'
    when r.formal_corpus_freeze_gate <> 'passed' then 'final_corpus_refreeze_required'
    when r.valid_scan_count < 1 then 'full_text_corpus_scan_required'
    when r.valid_theme_proof_count < 1 then 'verified_theme_analysis_required'
    when r.formal_v6_report_count < 1 then 'formal_report_required'
    else 'passed'
  end as goal_readiness_status
from public.aaaa_pipeline_readiness_authoritative_v1 r
cross join public.source_page_ocr_recovery_gate_v1 pr
cross join public.ocr_verification_gate_v2 o;

comment on view public.aaaa_pipeline_goal_readiness_v1 is
'AAAA completion order: page-first OCR recovery -> recovered-OCR inventory -> article crop OCR verification -> final refreeze -> full-text corpus analysis -> verified theme proof -> formal report. ocr_quality_gate is intentionally not treated as OCR accuracy.';

revoke all on public.aaaa_pipeline_goal_readiness_v1 from public,anon,authenticated;
grant select on public.aaaa_pipeline_goal_readiness_v1 to service_role;

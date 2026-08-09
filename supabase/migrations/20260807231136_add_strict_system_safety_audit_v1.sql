create or replace view public.strict_system_safety_audit_v1
with (security_invoker=true)
as
with legacy_cron as (
  select count(*)::integer n from cron.job where active and jobname in ('mj_report_worker','mj-vercel-status-poll-v1','mj-formal-report-orchestrator-v1','mj-classification-loop-v1')
), old_queued as (
  select count(*)::integer n from public.chat_jobs where status in ('queued','running') and created_at<timestamptz '2026-07-01 00:00:00+00'
), legacy_formal as (
  select count(*)::integer n from public.chat_reports where is_formal_report and coalesce(answer_json->>'formal_gate_version','')<>'formal_report_v6_claim_graph'
), invalid_v6_formal as (
  select count(*)::integer n from public.chat_reports r where r.is_formal_report and r.answer_json->>'formal_gate_version'='formal_report_v6_claim_graph' and not exists(select 1 from public.formal_report_jobs_v6 j where j.report_id=r.id and j.status='published' and public.formal_report_integrity_v6(j.id))
), public_secdef as (
  select count(*)::integer n
  from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
  where ns.nspname='public' and p.prosecdef
    and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))
), strict_rls_disabled as (
  select count(*)::integer n
  from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
  where ns.nspname='public' and c.relkind='r' and not c.relrowsecurity and c.relname in (
    'source_ocr_blocks_v1','source_ocr_block_assignments_v2','source_page_partition_jobs_v3','source_page_partition_proposals_v3','source_page_partition_pass_runs_v3','source_page_primary_capture_v1','article_source_regions','article_source_grounding_reviews_v3','article_source_grounding_pass_runs_v3',
    'article_embedding_jobs_v4','article_embeddings_v4','article_classification_jobs_v4','article_classification_pass_runs_v4','article_profiles_v4','article_category_memberships_v4',
    'source_grounded_duplicate_audit_runs_v5','source_grounded_duplicate_candidates_v5','source_grounded_duplicate_review_passes_v5',
    'full_corpus_review_jobs_v5','full_corpus_review_pass_runs_v5','full_corpus_reviewer_rows_v5','full_corpus_review_critic_rows_v5','full_corpus_article_reviews_v4','full_corpus_article_review_anchors_v4','full_corpus_theme_seeds_v4',
    'theme_candidate_synthesis_jobs_v5','theme_candidate_synthesis_pass_runs_v5','theme_candidate_proposals_v5','theme_candidate_critic_rows_v5','theme_seed_mapping_jobs_v5','theme_seed_mapping_pass_runs_v5','theme_seed_mapping_stage_v5','theme_candidates_v4','theme_seed_mappings_v4','theme_census_batches_v4','theme_census_pass_runs_v5','theme_census_stage_v5','theme_census_relations_v4','theme_analysis_proof_receipts_v6',
    'formal_report_jobs_v6','formal_report_pass_runs_v6','formal_report_claims_v6','formal_report_critic_rows_v6'
  )
), strict_direct_external_dml as (
  select count(*)::integer n
  from information_schema.role_table_grants g
  where g.table_schema='public' and g.grantee in ('anon','authenticated') and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
    and g.table_name in (
    'source_ocr_blocks_v1','source_ocr_block_assignments_v2','source_page_partition_jobs_v3','source_page_partition_proposals_v3','source_page_partition_pass_runs_v3','source_page_primary_capture_v1','article_source_regions','article_source_grounding_reviews_v3','article_source_grounding_pass_runs_v3',
    'article_embedding_jobs_v4','article_embeddings_v4','article_classification_jobs_v4','article_classification_pass_runs_v4','article_profiles_v4','article_category_memberships_v4',
    'source_grounded_duplicate_audit_runs_v5','source_grounded_duplicate_candidates_v5','source_grounded_duplicate_review_passes_v5',
    'full_corpus_review_jobs_v5','full_corpus_review_pass_runs_v5','full_corpus_reviewer_rows_v5','full_corpus_review_critic_rows_v5','full_corpus_article_reviews_v4','full_corpus_article_review_anchors_v4','full_corpus_theme_seeds_v4',
    'theme_candidate_synthesis_jobs_v5','theme_candidate_synthesis_pass_runs_v5','theme_candidate_proposals_v5','theme_candidate_critic_rows_v5','theme_seed_mapping_jobs_v5','theme_seed_mapping_pass_runs_v5','theme_seed_mapping_stage_v5','theme_candidates_v4','theme_seed_mappings_v4','theme_census_batches_v4','theme_census_pass_runs_v5','theme_census_stage_v5','theme_census_relations_v4','theme_analysis_proof_receipts_v6',
    'formal_report_jobs_v6','formal_report_pass_runs_v6','formal_report_claims_v6','formal_report_critic_rows_v6'
  )
)
select
  legacy_cron.n active_legacy_cron_count,
  old_queued.n orphan_legacy_active_job_count,
  legacy_formal.n legacy_formal_report_count,
  invalid_v6_formal.n invalid_v6_formal_report_count,
  public_secdef.n externally_executable_security_definer_count,
  strict_rls_disabled.n strict_rls_disabled_table_count,
  strict_direct_external_dml.n strict_external_dml_grant_count,
  case when legacy_cron.n+old_queued.n+legacy_formal.n+invalid_v6_formal.n+public_secdef.n+strict_rls_disabled.n+strict_direct_external_dml.n=0 then 'passed' else 'failed' end system_safety_gate
from legacy_cron,old_queued,legacy_formal,invalid_v6_formal,public_secdef,strict_rls_disabled,strict_direct_external_dml;

revoke all on public.strict_system_safety_audit_v1 from public,anon,authenticated;
grant select on public.strict_system_safety_audit_v1 to service_role;
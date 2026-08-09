begin;

create or replace view public.strict_system_table_registry_v2
with (security_invoker=true)
as
select v.relname::name as relname
from (values
  ('source_ocr_blocks_v1'),
  ('source_ocr_block_assignments_v2'),
  ('source_ocr_block_quality_v2'),
  ('source_page_partition_jobs_v3'),
  ('source_page_partition_proposals_v3'),
  ('source_page_partition_pass_runs_v3'),
  ('source_page_primary_capture_v1'),
  ('source_page_article_inventory_groups_v1'),
  ('source_page_article_inventory_jobs_v1'),
  ('source_page_article_inventory_pass_runs_v1'),
  ('source_page_article_inventory_mapping_pass_runs_v2'),
  ('source_page_article_inventory_mapping_stage_v2'),
  ('source_page_article_inventory_mappings_v2'),
  ('source_image_ingest_provenance_v2'),
  ('source_region_materialization_receipts_v6'),
  ('article_source_regions'),
  ('article_source_grounding_reviews_v3'),
  ('article_source_grounding_pass_runs_v3'),
  ('article_embedding_jobs_v4'),
  ('article_embeddings_v4'),
  ('article_ocr_verifications_v1'),
  ('ocr_verification_page_jobs_v2'),
  ('ocr_verification_pass_runs_v2'),
  ('ocr_verification_transcriptions_v2'),
  ('ocr_verification_crop_ocr_v4'),
  ('ocr_verification_vision_chunks_v4'),
  ('verified_ocr_corpus_receipts_v5'),
  ('article_classification_jobs_v4'),
  ('article_classification_pass_runs_v4'),
  ('article_classification_stage_v6'),
  ('article_profiles_v4'),
  ('article_category_memberships_v4'),
  ('category_classification_corpus_receipts_v7'),
  ('source_grounded_duplicate_audit_runs_v5'),
  ('source_grounded_duplicate_candidates_v5'),
  ('source_grounded_duplicate_review_passes_v5'),
  ('source_grounded_duplicate_review_jobs_v7'),
  ('full_corpus_review_jobs_v5'),
  ('full_corpus_review_pass_runs_v5'),
  ('full_corpus_reviewer_rows_v5'),
  ('full_corpus_review_critic_rows_v5'),
  ('full_corpus_article_reviews_v4'),
  ('full_corpus_article_review_anchors_v4'),
  ('full_corpus_theme_seeds_v4'),
  ('verified_article_review_jobs_v6'),
  ('verified_article_review_passes_v6'),
  ('verified_article_reviews_v6'),
  ('verified_article_review_anchors_v6'),
  ('verified_article_theme_seeds_v6'),
  ('verified_article_review_corpus_receipts_v7'),
  ('theme_candidate_synthesis_jobs_v5'),
  ('theme_candidate_synthesis_pass_runs_v5'),
  ('theme_candidate_proposals_v5'),
  ('theme_candidate_critic_rows_v5'),
  ('theme_seed_mapping_jobs_v5'),
  ('theme_seed_mapping_pass_runs_v5'),
  ('theme_seed_mapping_stage_v5'),
  ('theme_candidates_v4'),
  ('theme_seed_mappings_v4'),
  ('theme_census_batches_v4'),
  ('theme_census_pass_runs_v5'),
  ('theme_census_stage_v5'),
  ('theme_census_relations_v4'),
  ('theme_analysis_proof_receipts_v6'),
  ('verified_theme_analysis_runs_v7'),
  ('verified_theme_seed_chunk_jobs_v7'),
  ('verified_theme_seed_chunk_passes_v7'),
  ('verified_theme_candidate_proposals_v7'),
  ('verified_theme_consolidation_jobs_v7'),
  ('verified_theme_consolidation_passes_v7'),
  ('verified_theme_candidates_v7'),
  ('verified_theme_census_batches_v7'),
  ('verified_theme_census_passes_v7'),
  ('verified_theme_census_article_outcomes_v7'),
  ('verified_theme_census_relations_v7'),
  ('verified_theme_census_receipts_v8'),
  ('verified_theme_analysis_proof_receipts_v8'),
  ('verified_theme_report_runs_v8'),
  ('verified_theme_report_note_jobs_v8'),
  ('verified_theme_report_note_passes_v8'),
  ('verified_theme_report_notes_v8'),
  ('verified_theme_report_final_jobs_v8'),
  ('verified_theme_report_final_passes_v8'),
  ('verified_theme_reports_v8'),
  ('formal_report_jobs_v6'),
  ('formal_report_pass_runs_v6'),
  ('formal_report_claims_v6'),
  ('formal_report_critic_rows_v6'),
  ('formal_corpus_zero_audit_receipts_v2')
) as v(relname);

revoke all on public.strict_system_table_registry_v2 from public, anon, authenticated;
grant select on public.strict_system_table_registry_v2 to service_role;

create or replace view public.strict_system_safety_audit_v1
as
with legacy_cron as (
  select count(*)::integer as n
  from cron.job
  where active
    and jobname = any(array[
      'mj_report_worker'::text,
      'mj-vercel-status-poll-v1'::text,
      'mj-formal-report-orchestrator-v1'::text,
      'mj-classification-loop-v1'::text
    ])
), old_queued as (
  select count(*)::integer as n
  from public.chat_jobs
  where status = any(array['queued'::text,'running'::text])
    and created_at < '2026-07-01 00:00:00+00'::timestamptz
), legacy_formal as (
  select count(*)::integer as n
  from public.chat_reports
  where is_formal_report
    and coalesce(answer_json->>'formal_gate_version','') <> 'formal_report_v6_claim_graph'
), invalid_v6_formal as (
  select count(*)::integer as n
  from public.chat_reports r
  where r.is_formal_report
    and r.answer_json->>'formal_gate_version' = 'formal_report_v6_claim_graph'
    and not exists (
      select 1
      from public.formal_report_jobs_v6 j
      where j.report_id = r.id
        and j.status = 'published'
        and public.formal_report_integrity_v6(j.id)
    )
), public_secdef as (
  select count(*)::integer as n
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.prosecdef
    and (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    )
), strict_rls_disabled as (
  select count(*)::integer as n
  from public.strict_system_table_registry_v2 r
  left join pg_class c
    on c.relname = r.relname
   and c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
  where c.oid is null or not c.relrowsecurity
), strict_direct_external_dml as (
  select count(*)::integer as n
  from information_schema.role_table_grants g
  join public.strict_system_table_registry_v2 r
    on r.relname::text = g.table_name
  where g.table_schema = 'public'
    and g.grantee in ('anon','authenticated')
    and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
)
select
  legacy_cron.n as active_legacy_cron_count,
  old_queued.n as orphan_legacy_active_job_count,
  legacy_formal.n as legacy_formal_report_count,
  invalid_v6_formal.n as invalid_v6_formal_report_count,
  public_secdef.n as externally_executable_security_definer_count,
  strict_rls_disabled.n as strict_rls_disabled_table_count,
  strict_direct_external_dml.n as strict_external_dml_grant_count,
  case
    when legacy_cron.n + old_queued.n + legacy_formal.n + invalid_v6_formal.n + public_secdef.n + strict_rls_disabled.n + strict_direct_external_dml.n = 0
      then 'passed'::text
    else 'failed'::text
  end as system_safety_gate
from legacy_cron, old_queued, legacy_formal, invalid_v6_formal, public_secdef, strict_rls_disabled, strict_direct_external_dml;

revoke all on public.strict_system_safety_audit_v1 from public, anon, authenticated;
grant select on public.strict_system_safety_audit_v1 to service_role;

commit;
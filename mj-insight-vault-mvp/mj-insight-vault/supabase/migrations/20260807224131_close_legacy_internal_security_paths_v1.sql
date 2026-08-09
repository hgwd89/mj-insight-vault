do $$
declare
  t text;
  v text;
  f regprocedure;
begin
  -- Internal legacy tables must never be writable/readable through PostgREST roles.
  foreach t in array array[
    'source_ocr_blocks_v1',
    'source_ocr_block_assignments_v2',
    'clean_embedding_duplicate_audit_runs_v1',
    'clean_embedding_duplicate_candidates_v1',
    'source_page_partition_jobs_v2',
    'source_page_partition_proposals_v2',
    'source_image_same_page_reviews_v2',
    'source_image_equivalence_reviews_v1',
    'source_storage_identity_reviews_v1'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from anon, authenticated',t);
    execute format('grant all on table public.%I to service_role',t);
  end loop;

  -- These views are internal proof/readiness surfaces; do not expose definer privileges.
  foreach v in array array[
    'formal_source_ocr_blocks_v1',
    'aaaa_pipeline_readiness_v3',
    'source_publication_date_effective_v1',
    'article_date_integrity_v1',
    'source_page_block_partition_gate_v2',
    'article_source_region_integrity_v2',
    'formal_source_grounded_articles_v2',
    'article_source_region_gate_v2',
    'article_content_role_audit_v1',
    'formal_corpus_duplicate_gate_v4',
    'article_source_region_gate_v3'
  ] loop
    execute format('alter view public.%I set (security_invoker = true)',v);
    execute format('revoke all on table public.%I from anon, authenticated',v);
    execute format('grant select on table public.%I to service_role',v);
  end loop;

  -- Legacy/internal SECURITY DEFINER RPCs must be server-only.
  foreach f in array array[
    'public.claim_source_page_partition_job_v2(integer)'::regprocedure,
    'public.enforce_aaaa_formal_contract_v1()'::regprocedure,
    'public.enforce_monthly_rollup_ready_v3_v1()'::regprocedure,
    'public.enqueue_source_page_partition_jobs_v2()'::regprocedure,
    'public.finalize_source_page_partition_job_v2(uuid,uuid,text,text)'::regprocedure,
    'public.formal_corpus_freeze_snapshot_v1()'::regprocedure,
    'public.formal_monthly_source_fingerprint_v3(text)'::regprocedure,
    'public.full_corpus_run_integrity_v2(uuid)'::regprocedure,
    'public.grounding_review_passes_v3(uuid,uuid,uuid,text,text,text)'::regprocedure,
    'public.match_articles(public.vector,integer)'::regprocedure,
    'public.monthly_rollup_v3_payload_integrity_v1(text,integer,uuid[],jsonb)'::regprocedure,
    'public.monthly_rollup_v3_payload_integrity_v2(text,integer,uuid[],jsonb)'::regprocedure,
    'public.normalize_hierarchical_report_before_gate_v1()'::regprocedure,
    'public.normalize_hierarchical_report_payload_v1(jsonb)'::regprocedure,
    'public.quarantine_invalid_formal_report_attempt_v1()'::regprocedure,
    'public.refresh_source_ocr_blocks_v1(uuid)'::regprocedure,
    'public.report_aaaa_contract_v1(jsonb)'::regprocedure,
    'public.report_aaaa_v4_integrity_v1(jsonb,uuid)'::regprocedure,
    'public.report_evidence_claims_analytical_v1(jsonb)'::regprocedure,
    'public.report_theme_support_integrity_v2(jsonb,uuid)'::regprocedure,
    'public.source_page_article_set_proof_v2(uuid)'::regprocedure,
    'public.source_page_identity_article_set_proof_v3(uuid)'::regprocedure,
    'public.validate_theme_candidate_v4_row()'::regprocedure
  ] loop
    execute format('revoke execute on function %s from anon, authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;

  alter function public.consumer_relevance_v4(text,text) set search_path = pg_catalog, public;
end $$;
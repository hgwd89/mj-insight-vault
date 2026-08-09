do $$
declare f regprocedure;
begin
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
    execute format('revoke execute on function %s from public, anon, authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end $$;
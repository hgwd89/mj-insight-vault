revoke all on table public.formal_corpus_page_identity_v1 from anon, authenticated;
revoke all on table public.formal_source_page_identity_gate_v1 from anon, authenticated;
revoke all on table public.formal_corpus_freeze_gate_v1 from anon, authenticated;
revoke all on table public.source_page_block_partition_gate_v3 from anon, authenticated;
revoke all on table public.article_source_region_integrity_v3 from anon, authenticated;
revoke all on table public.article_source_region_gate_v4 from anon, authenticated;
revoke all on table public.article_source_region_integrity_v4 from anon, authenticated;
revoke all on table public.aaaa_pipeline_readiness_v4 from anon, authenticated;
revoke all on table public.aaaa_pipeline_readiness_v5 from anon, authenticated;

grant select on table public.formal_corpus_page_identity_v1 to service_role;
grant select on table public.formal_source_page_identity_gate_v1 to service_role;
grant select on table public.formal_corpus_freeze_gate_v1 to service_role;
grant select on table public.source_page_block_partition_gate_v3 to service_role;
grant select on table public.article_source_region_integrity_v3 to service_role;
grant select on table public.article_source_region_gate_v4 to service_role;
grant select on table public.article_source_region_integrity_v4 to service_role;
grant select on table public.aaaa_pipeline_readiness_v4 to service_role;
grant select on table public.aaaa_pipeline_readiness_v5 to service_role;
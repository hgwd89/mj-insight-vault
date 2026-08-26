-- READ ONLY: export authoritative PostgreSQL definitions for the verified downstream pipeline.
-- This query must not mutate production. It returns one JSONB document containing exact
-- function bodies/signatures/security/ACLs and relation/view/table structure/security metadata.
-- Run only against the authoritative production database once connectivity is restored.

with target_functions(name) as (
  values
    ('claim_article_classification_job_v6'),
    ('claim_article_embedding_job_v5'),
    ('claim_source_grounded_duplicate_review_job_v7'),
    ('claim_verified_article_review_job_v6'),
    ('claim_verified_theme_census_batch_v7'),
    ('claim_verified_theme_consolidation_job_v7'),
    ('claim_verified_theme_seed_chunk_job_v7'),
    ('complete_article_embedding_job_v5'),
    ('create_source_grounded_duplicate_audit_run_v6'),
    ('create_verified_theme_analysis_run_v7'),
    ('enqueue_article_classification_jobs_v6'),
    ('enqueue_article_embedding_jobs_v5'),
    ('enqueue_verified_article_review_jobs_v6'),
    ('enqueue_verified_theme_census_v7'),
    ('fail_article_classification_job_v6'),
    ('fail_article_embedding_job_v5'),
    ('fail_source_grounded_duplicate_review_job_v7'),
    ('fail_verified_article_review_job_v6'),
    ('fail_verified_theme_census_batch_v7'),
    ('fail_verified_theme_consolidation_job_v7'),
    ('fail_verified_theme_seed_chunk_job_v7'),
    ('finalize_source_grounded_duplicate_audit_v7'),
    ('get_article_classification_input_v6'),
    ('get_source_grounded_duplicate_review_input_v7'),
    ('get_verified_article_review_input_v6'),
    ('get_verified_theme_census_input_v7'),
    ('get_verified_theme_consolidation_input_v7'),
    ('get_verified_theme_seed_chunk_input_v7'),
    ('populate_source_grounded_duplicate_candidates_v6'),
    ('prepare_verified_theme_consolidation_v7'),
    ('record_verified_article_review_corpus_receipt_v7'),
    ('record_verified_theme_analysis_proof_v8'),
    ('store_article_classification_pass_v6'),
    ('store_source_grounded_duplicate_review_v7'),
    ('store_verified_article_review_pass_v6'),
    ('store_verified_theme_census_pass_v7'),
    ('store_verified_theme_consolidation_pass_v7'),
    ('store_verified_theme_seed_chunk_pass_v7')
),
target_relations(name) as (
  values
    ('article_classification_quality_gate_v6'),
    ('article_embedding_jobs_v4'),
    ('article_embedding_quality_gate_v5'),
    ('current_verified_article_review_corpus_receipt_v7'),
    ('current_verified_theme_analysis_proof_v8'),
    ('source_grounded_duplicate_audit_runs_v5'),
    ('source_grounded_duplicate_gate_v6'),
    ('source_grounded_duplicate_review_jobs_v7'),
    ('verified_article_review_gate_v6'),
    ('verified_article_review_jobs_v6'),
    ('verified_theme_analysis_runs_v7'),
    ('verified_theme_candidate_gate_v7'),
    ('verified_theme_census_batches_v7'),
    ('verified_theme_census_gate_v7'),
    ('verified_theme_consolidation_jobs_v7'),
    ('verified_theme_seed_chunk_jobs_v7')
),
function_export as (
  select
    tf.name as requested_name,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'oid', p.oid,
          'schema', n.nspname,
          'name', p.proname,
          'identity_arguments', pg_get_function_identity_arguments(p.oid),
          'arguments', pg_get_function_arguments(p.oid),
          'result', pg_get_function_result(p.oid),
          'definition', pg_get_functiondef(p.oid),
          'owner', pg_get_userbyid(p.proowner),
          'security_definer', p.prosecdef,
          'leakproof', p.proleakproof,
          'strict', p.proisstrict,
          'volatility', p.provolatile,
          'parallel', p.proparallel,
          'config', coalesce(to_jsonb(p.proconfig), '[]'::jsonb),
          'acl', coalesce(to_jsonb(p.proacl), '[]'::jsonb),
          'comment', obj_description(p.oid, 'pg_proc'),
          'routine_grants', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'grantee', rp.grantee,
                'privilege_type', rp.privilege_type,
                'is_grantable', rp.is_grantable
              )
              order by rp.grantee, rp.privilege_type
            )
            from information_schema.routine_privileges rp
            where rp.specific_schema = n.nspname
              and rp.routine_name = p.proname
          ), '[]'::jsonb)
        )
        order by pg_get_function_identity_arguments(p.oid)
      ) filter (where p.oid is not null),
      '[]'::jsonb
    ) as matches
  from target_functions tf
  left join pg_proc p
    on p.proname = tf.name
   and p.pronamespace = 'public'::regnamespace
  left join pg_namespace n on n.oid = p.pronamespace
  group by tf.name
),
relation_export as (
  select
    tr.name as requested_name,
    case when c.oid is null then null else jsonb_build_object(
      'oid', c.oid,
      'schema', n.nspname,
      'name', c.relname,
      'relkind', c.relkind,
      'persistence', c.relpersistence,
      'owner', pg_get_userbyid(c.relowner),
      'row_security', c.relrowsecurity,
      'force_row_security', c.relforcerowsecurity,
      'acl', coalesce(to_jsonb(c.relacl), '[]'::jsonb),
      'reloptions', coalesce(to_jsonb(c.reloptions), '[]'::jsonb),
      'comment', obj_description(c.oid, 'pg_class'),
      'view_definition', case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, true) else null end,
      'columns', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'ordinal', a.attnum,
            'name', a.attname,
            'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
            'not_null', a.attnotnull,
            'identity', a.attidentity,
            'generated', a.attgenerated,
            'default', pg_get_expr(ad.adbin, ad.adrelid),
            'collation', case when a.attcollation <> 0 then coll.collname else null end,
            'comment', col_description(a.attrelid, a.attnum)
          ) order by a.attnum
        )
        from pg_attribute a
        left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
        left join pg_collation coll on coll.oid = a.attcollation
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ), '[]'::jsonb),
      'constraints', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'name', con.conname,
            'type', con.contype,
            'definition', pg_get_constraintdef(con.oid, true),
            'validated', con.convalidated,
            'deferrable', con.condeferrable,
            'deferred', con.condeferred
          ) order by con.conname
        )
        from pg_constraint con
        where con.conrelid = c.oid
      ), '[]'::jsonb),
      'indexes', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'name', idx.relname,
            'definition', pg_get_indexdef(i.indexrelid),
            'primary', i.indisprimary,
            'unique', i.indisunique,
            'valid', i.indisvalid
          ) order by idx.relname
        )
        from pg_index i
        join pg_class idx on idx.oid = i.indexrelid
        where i.indrelid = c.oid
      ), '[]'::jsonb),
      'policies', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'name', pol.policyname,
            'permissive', pol.permissive,
            'roles', pol.roles,
            'command', pol.cmd,
            'using', pol.qual,
            'check', pol.with_check
          ) order by pol.policyname
        )
        from pg_policies pol
        where pol.schemaname = 'public' and pol.tablename = c.relname
      ), '[]'::jsonb),
      'triggers', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'name', t.tgname,
            'definition', pg_get_triggerdef(t.oid, true),
            'enabled', t.tgenabled
          ) order by t.tgname
        )
        from pg_trigger t
        where t.tgrelid = c.oid and not t.tgisinternal
      ), '[]'::jsonb),
      'table_grants', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'grantee', g.grantee,
            'privilege_type', g.privilege_type,
            'is_grantable', g.is_grantable
          ) order by g.grantee, g.privilege_type
        )
        from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = c.relname
      ), '[]'::jsonb)
    ) end as definition
  from target_relations tr
  left join pg_class c
    on c.relname = tr.name
   and c.relnamespace = 'public'::regnamespace
  left join pg_namespace n on n.oid = c.relnamespace
),
manifest as (
  select
    (select count(*) from target_functions) as target_function_count,
    (select count(*) from target_relations) as target_relation_count,
    (select count(*) from function_export where jsonb_array_length(matches) = 0) as missing_function_count,
    (select count(*) from relation_export where definition is null) as missing_relation_count
)
select jsonb_build_object(
  'database', current_database(),
  'server_version', current_setting('server_version'),
  'manifest', to_jsonb(manifest),
  'functions', (select jsonb_agg(jsonb_build_object('requested_name', requested_name, 'matches', matches) order by requested_name) from function_export),
  'relations', (select jsonb_agg(jsonb_build_object('requested_name', requested_name, 'definition', definition) order by requested_name) from relation_export)
) as verified_pipeline_authoritative_ddl_export
from manifest;

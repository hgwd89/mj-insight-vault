create or replace function public.resolve_inventory_one_formal_article_review_v1(
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
set statement_timeout to '90s'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_enabled boolean;
  v_formal_count integer;
  v_article_id uuid;
  v_article_headline text;
  v_article_body text;
  v_article_blocks integer[];
  v_non_article_blocks integer[];
  v_candidate_count integer;
  v_candidate_passes integer;
  v_strong_headline_passes integer;
  v_anchor text;
  v_group_text text;
  v_body_score numeric;
  v_evidence jsonb;
  v_result jsonb;
begin
  select enabled
    into v_enabled
  from public.inventory_v3_execution_control_v1
  where singleton = true;

  if coalesce(v_enabled, true) then
    raise exception 'one_formal_article_review_resolver_requires_execution_disabled';
  end if;

  select *
    into j
  from public.source_page_article_inventory_jobs_v1
  where id = p_job_id
  for update;

  if not found
     or j.status <> 'needs_review'
     or j.inventory_version <> 'page_article_inventory_v4_recovered_ocr'
     or not j.requires_third_pass
     or j.existing_article_count <> 1 then
    raise exception 'one_formal_article_review_resolver_job_state_mismatch';
  end if;

  if j.error_message <> 'One-model-only visual article has no independent support.'
     and j.error_message !~ '^Three-way visual tie at block [0-9]+\\.$'
     and j.error_message !~ '^Ambiguous article correspondence for .+\\.$' then
    raise exception 'one_formal_article_review_resolver_error_class_unsupported:%', j.error_message;
  end if;

  if not exists (
    select 1
    from public.formal_corpus_freeze_gate_v2
    where freeze_gate_v2 = 'passed'
      and freeze_receipt_id = j.freeze_receipt_id
  ) then
    raise exception 'one_formal_article_review_resolver_freeze_stale';
  end if;

  if exists(select 1 from public.source_page_article_inventory_mappings_v2 where job_id = j.id)
     or exists(select 1 from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id = j.id)
     or exists(select 1 from public.source_region_materialization_receipts_v6 where inventory_job_id = j.id)
     or exists(select 1 from public.inventory_semantic_repartition_receipts_v1 where job_id = j.id) then
    raise exception 'one_formal_article_review_resolver_downstream_state_exists';
  end if;

  if (
    select count(*)::integer
    from public.source_page_article_inventory_pass_runs_v1
    where job_id = j.id
      and pass_kind in ('mapper', 'critic', 'adjudicator')
  ) <> 3 then
    raise exception 'one_formal_article_review_resolver_three_passes_required';
  end if;

  select count(*)::integer
    into v_formal_count
  from public.formal_corpus_articles_v1 f
  join public.source_page_capture_map_v1 cm
    on cm.source_image_id = f.source_image_id
  where cm.page_identity_source_image_id = j.page_identity_source_image_id;

  if v_formal_count <> 1 then
    raise exception 'one_formal_article_review_resolver_formal_count_mismatch:%', v_formal_count;
  end if;

  select f.id, f.headline, ar.analysis_body_clean
    into v_article_id, v_article_headline, v_article_body
  from public.formal_corpus_articles_v1 f
  join public.articles ar
    on ar.id = f.id
  join public.source_page_capture_map_v1 cm
    on cm.source_image_id = f.source_image_id
  where cm.page_identity_source_image_id = j.page_identity_source_image_id
  limit 1;

  with raw_groups as (
    select
      g.pass_kind,
      g.group_fingerprint,
      g.headline_anchor,
      g.block_indices,
      cardinality(g.block_indices) as block_count,
      string_agg(b.block_text, E'\n---\n' order by b.block_index) as group_text
    from public.source_page_article_inventory_groups_v1 g
    join public.source_page_article_inventory_blocks_v1 b
      on b.job_id = g.job_id
     and b.block_index = any(g.block_indices)
    where g.job_id = j.id
      and g.group_kind = 'article'
    group by g.pass_kind, g.group_fingerprint, g.headline_anchor, g.block_indices
  ),
  scored as (
    select
      r.*,
      greatest(
        extensions.similarity(lower(coalesce(v_article_headline, '')), lower(coalesce(r.headline_anchor, ''))),
        extensions.similarity(lower(coalesce(v_article_headline, '')), lower(left(coalesce(r.group_text, ''), 240)))
      )::numeric as headline_score,
      extensions.similarity(
        public.normalize_article_headline_v1(left(coalesce(r.group_text, ''), 4000)),
        public.normalize_article_headline_v1(left(coalesce(v_article_body, ''), 4000))
      )::numeric as body_score
    from raw_groups r
  ),
  candidates as (
    select *
    from scored
    where block_count <= greatest(50, floor(j.block_count * 0.90)::integer)
      and (headline_score >= 0.25 or body_score >= 0.05)
  ),
  stats as (
    select
      count(*)::integer as candidate_count,
      count(distinct pass_kind)::integer as candidate_passes,
      count(distinct pass_kind) filter (where headline_score >= 0.25)::integer as strong_headline_passes
    from candidates
  ),
  candidate_blocks as (
    select
      bi.block_index,
      count(*)::integer as votes,
      count(*) filter (where c.headline_score >= 0.25)::integer as strong_votes
    from candidates c
    cross join lateral unnest(c.block_indices) as bi(block_index)
    group by bi.block_index
  ),
  selected_blocks as (
    select array_agg(cb.block_index order by cb.block_index)::integer[] as article_blocks
    from candidate_blocks cb
    cross join stats s
    where case
      when s.strong_headline_passes >= 2 then cb.strong_votes >= 2
      else cb.votes >= 1
    end
  ),
  all_blocks as (
    select array_agg(b.block_index order by b.block_index)::integer[] as block_indices
    from public.source_page_article_inventory_blocks_v1 b
    where b.job_id = j.id
      and b.source_ocr_json_sha256 = j.source_ocr_json_sha256
  ),
  non_article_blocks as (
    select array_agg(x.block_index order by x.block_index)::integer[] as block_indices
    from all_blocks ab
    cross join lateral unnest(ab.block_indices) as x(block_index)
    cross join selected_blocks sb
    where not x.block_index = any(coalesce(sb.article_blocks, array[]::integer[]))
  ),
  selected_text as (
    select string_agg(b.block_text, E'\n---\n' order by b.block_index) as group_text
    from selected_blocks sb
    join public.source_page_article_inventory_blocks_v1 b
      on b.job_id = j.id
     and b.block_index = any(sb.article_blocks)
  ),
  best_anchor as (
    select c.headline_anchor
    from candidates c
    cross join selected_text st
    where btrim(coalesce(c.headline_anchor, '')) <> ''
      and position(lower(c.headline_anchor) in lower(coalesce(st.group_text, ''))) > 0
    order by c.headline_score desc, c.body_score desc, c.block_count asc, c.pass_kind
    limit 1
  ),
  body_check as (
    select extensions.similarity(
      public.normalize_article_headline_v1(left(coalesce(st.group_text, ''), 4000)),
      public.normalize_article_headline_v1(left(coalesce(v_article_body, ''), 4000))
    )::numeric as body_score
    from selected_text st
  ),
  evidence as (
    select jsonb_build_object(
      'formal_article_id', v_article_id,
      'formal_article_headline', v_article_headline,
      'review_error', j.error_message,
      'candidate_count', (select candidate_count from stats),
      'candidate_passes', (select candidate_passes from stats),
      'strong_headline_passes', (select strong_headline_passes from stats),
      'selection_rule', case when (select strong_headline_passes from stats) >= 2 then 'strong_headline_votes_at_least_2' else 'precise_formal_candidate_union' end,
      'candidates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'pass_kind', pass_kind,
          'group_fingerprint', group_fingerprint,
          'headline_anchor', headline_anchor,
          'block_count', block_count,
          'headline_score', headline_score,
          'body_score', body_score
        ) order by headline_score desc, body_score desc, pass_kind)
        from candidates
      ), '[]'::jsonb),
      'api_calls', 0
    ) as evidence_json
  )
  select
    sb.article_blocks,
    nb.block_indices,
    (select candidate_count from stats),
    (select candidate_passes from stats),
    (select strong_headline_passes from stats),
    (select headline_anchor from best_anchor),
    st.group_text,
    bc.body_score,
    e.evidence_json
    into
      v_article_blocks,
      v_non_article_blocks,
      v_candidate_count,
      v_candidate_passes,
      v_strong_headline_passes,
      v_anchor,
      v_group_text,
      v_body_score,
      v_evidence
  from selected_blocks sb
  cross join non_article_blocks nb
  cross join selected_text st
  cross join body_check bc
  cross join evidence e;

  if coalesce(v_candidate_count, 0) < 1
     or coalesce(v_candidate_passes, 0) < 1
     or coalesce(cardinality(v_article_blocks), 0) < 3
     or coalesce(cardinality(v_non_article_blocks), 0) < 1 then
    raise exception 'one_formal_article_review_resolver_no_safe_partition';
  end if;

  if coalesce(v_body_score, 0) < 0.05 then
    raise exception 'one_formal_article_review_resolver_body_score_too_low:%', v_body_score;
  end if;

  if btrim(coalesce(v_anchor, '')) = ''
     or position(lower(v_anchor) in lower(coalesce(v_group_text, ''))) = 0 then
    raise exception 'one_formal_article_review_resolver_anchor_not_grounded';
  end if;

  v_result := public.apply_inventory_third_pass_semantic_repartition_v1(
    j.id,
    jsonb_build_array(
      jsonb_build_object(
        'group_kind', 'article',
        'block_indices', to_jsonb(v_article_blocks),
        'headline_anchor', v_anchor,
        'confidence', 0.95,
        'reason', 'one_formal_article_visual_review_v1: selected OCR blocks match the single formal article body/headline under strict page-local evidence'
      ),
      jsonb_build_object(
        'group_kind', 'non_article',
        'block_indices', to_jsonb(v_non_article_blocks),
        'non_article_role', 'outside_formal_article_semantic_repartition',
        'confidence', 0.99,
        'reason', 'one_formal_article_visual_review_v1 complement: OCR blocks are outside the single formal article for this page identity'
      )
    ),
    'Resolve single-formal-article visual review by strict formal-body grounding and page-local OCR block repartition; no API call and no status promotion without downstream finalize.',
    v_evidence || jsonb_build_object(
      'selected_anchor', v_anchor,
      'selected_article_blocks', cardinality(v_article_blocks),
      'selected_non_article_blocks', cardinality(v_non_article_blocks),
      'selected_body_score', v_body_score
    )
  );

  return v_result || jsonb_build_object(
    'resolver', 'one_formal_article_visual_review_v1',
    'selected_article_blocks', cardinality(v_article_blocks),
    'selected_non_article_blocks', cardinality(v_non_article_blocks),
    'selected_body_score', v_body_score,
    'candidate_count', v_candidate_count,
    'candidate_passes', v_candidate_passes,
    'strong_headline_passes', v_strong_headline_passes
  );
end
$function$;

revoke all on function public.resolve_inventory_one_formal_article_review_v1(uuid) from public, anon, authenticated;
grant execute on function public.resolve_inventory_one_formal_article_review_v1(uuid) to service_role;

create or replace function public.bulk_resolve_inventory_one_formal_article_reviews_v1(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
set statement_timeout to '180s'
as $function$
declare
  v_job record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_resolved integer := 0;
  v_failed integer := 0;
begin
  for v_job in
    select j.id
    from public.source_page_article_inventory_jobs_v1 j
    join public.formal_corpus_freeze_gate_v2 fg
      on fg.freeze_receipt_id = j.freeze_receipt_id
     and fg.freeze_gate_v2 = 'passed'
    where j.inventory_version = 'page_article_inventory_v4_recovered_ocr'
      and j.status = 'needs_review'
      and j.requires_third_pass
      and j.existing_article_count = 1
      and (
        j.error_message = 'One-model-only visual article has no independent support.'
        or j.error_message ~ '^Three-way visual tie at block [0-9]+\\.$'
        or j.error_message ~ '^Ambiguous article correspondence for .+\\.$'
      )
      and not exists(select 1 from public.source_page_article_inventory_mappings_v2 m where m.job_id = j.id)
      and not exists(select 1 from public.source_page_article_inventory_mapping_pass_runs_v2 m where m.job_id = j.id)
      and not exists(select 1 from public.source_region_materialization_receipts_v6 r where r.inventory_job_id = j.id)
      and not exists(select 1 from public.inventory_semantic_repartition_receipts_v1 r where r.job_id = j.id)
    order by j.updated_at, j.id
    limit v_limit
  loop
    begin
      v_result := public.resolve_inventory_one_formal_article_review_v1(v_job.id);
      v_resolved := v_resolved + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object('job_id', v_job.id, 'ok', true, 'result', v_result));
    exception when others then
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object('job_id', v_job.id, 'ok', false, 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'attempted', v_resolved + v_failed,
    'resolved', v_resolved,
    'failed', v_failed,
    'results', v_results
  );
end
$function$;

revoke all on function public.bulk_resolve_inventory_one_formal_article_reviews_v1(integer) from public, anon, authenticated;
grant execute on function public.bulk_resolve_inventory_one_formal_article_reviews_v1(integer) to service_role;

create or replace function public.resolve_inventory_review_by_formal_body_subset_exclusion_v1(
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
set statement_timeout to '120s'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_enabled boolean;
  v_third boolean;
  v_candidates integer;
  v_pass text;
  v_eff_groups integer;
  v_assigned_groups integer;
  v_unassigned_groups integer;
  v_min_conf numeric;
  v_bad_merged integer;
  v_groups jsonb;
  v_assignments jsonb;
  v_proof text;
  v_result jsonb;
begin
  select enabled, grounded_third_pass_enabled
    into v_enabled, v_third
  from public.inventory_v3_execution_control_v1
  where singleton = true
  for update;

  if coalesce(v_enabled, true) or coalesce(v_third, true) then
    raise exception 'formal_body_subset_exclusion_requires_execution_disabled';
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
     or j.existing_article_count < 2 then
    raise exception 'formal_body_subset_exclusion_job_state_mismatch';
  end if;

  if not exists (
    select 1
    from public.formal_corpus_freeze_gate_v2
    where freeze_gate_v2 = 'passed'
      and freeze_receipt_id = j.freeze_receipt_id
  ) then
    raise exception 'formal_body_subset_exclusion_freeze_stale';
  end if;

  if exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 where job_id = j.id)
     or exists(select 1 from public.source_page_article_inventory_mappings_v2 where job_id = j.id)
     or exists(select 1 from public.source_region_materialization_receipts_v6 where inventory_job_id = j.id) then
    raise exception 'formal_body_subset_exclusion_downstream_exists';
  end if;

  if (
    select count(*)::integer
    from public.source_page_article_inventory_pass_runs_v1
    where job_id = j.id
      and pass_kind in ('mapper', 'critic', 'adjudicator')
  ) <> 3
     or (
       select count(distinct model)::integer
       from public.source_page_article_inventory_pass_runs_v1
       where job_id = j.id
         and pass_kind in ('mapper', 'critic', 'adjudicator')
     ) <> 3 then
    raise exception 'formal_body_subset_exclusion_three_passes_required';
  end if;

  with raw as (
    select
      g.pass_kind,
      g.group_fingerprint,
      g.headline_anchor,
      g.confidence,
      g.block_indices,
      string_agg(b.block_text, E'\n' order by b.block_index) as group_text
    from public.source_page_article_inventory_groups_v1 g
    join public.source_page_article_inventory_blocks_v1 b
      on b.job_id = g.job_id
     and b.block_index = any(g.block_indices)
    where g.job_id = j.id
      and g.group_kind = 'article'
      and g.pass_kind in ('mapper', 'critic', 'adjudicator')
    group by g.pass_kind, g.group_fingerprint, g.headline_anchor, g.confidence, g.block_indices
  ),
  arts as (
    select a.id as article_id, a.analysis_body_clean
    from public.formal_corpus_articles_v1 fa
    join public.articles a
      on a.id = fa.id
    join public.source_page_capture_map_v1 cm
      on cm.source_image_id = a.source_image_id
    where cm.page_identity_source_image_id = j.page_identity_source_image_id
  ),
  scores as (
    select
      r.*,
      a.article_id,
      extensions.similarity(
        public.normalize_article_headline_v1(left(coalesce(r.group_text, ''), 4000)),
        public.normalize_article_headline_v1(left(coalesce(a.analysis_body_clean, ''), 4000))
      )::numeric as body_score
    from raw r
    cross join arts a
  ),
  ranked as (
    select
      s.*,
      row_number() over(partition by pass_kind, group_fingerprint order by body_score desc, article_id) as best_rank,
      body_score - lead(body_score) over(partition by pass_kind, group_fingerprint order by body_score desc, article_id) as body_margin
    from scores s
  ),
  best as (
    select *
    from ranked
    where best_rank = 1
  ),
  assignments as (
    select *
    from best
    where body_score >= 0.08
      and coalesce(body_margin, body_score) >= 0.04
  ),
  per_pass as (
    select
      r.pass_kind,
      count(distinct r.group_fingerprint)::integer as eff_groups,
      count(distinct a.group_fingerprint)::integer as assigned_groups,
      count(distinct a.article_id)::integer as assigned_articles,
      count(distinct r.group_fingerprint)::integer - count(distinct a.group_fingerprint)::integer as unassigned_groups,
      min(a.confidence) as min_conf,
      max(b.body_score) filter (where a.group_fingerprint is null) as unassigned_best_score
    from raw r
    join best b
      on b.pass_kind = r.pass_kind
     and b.group_fingerprint = r.group_fingerprint
    left join assignments a
      on a.pass_kind = r.pass_kind
     and a.group_fingerprint = r.group_fingerprint
    group by r.pass_kind
  ),
  candidates as (
    select *
    from per_pass
    where assigned_articles = j.existing_article_count
      and assigned_groups >= j.existing_article_count
      and assigned_groups < eff_groups
      and unassigned_groups >= 1
      and coalesce(min_conf, 0) >= 0.80
      and coalesce(unassigned_best_score, 0) < 0.08
  )
  select count(*)::integer,
         min(pass_kind),
         min(eff_groups),
         min(assigned_groups),
         min(unassigned_groups),
         min(min_conf)
    into v_candidates,
         v_pass,
         v_eff_groups,
         v_assigned_groups,
         v_unassigned_groups,
         v_min_conf
  from candidates;

  if v_candidates <> 1 then
    raise exception 'formal_body_subset_exclusion_requires_unique_candidate:%', v_candidates;
  end if;

  with raw as (
    select
      g.group_fingerprint,
      g.headline_anchor,
      g.confidence,
      g.block_indices,
      string_agg(b.block_text, E'\n' order by b.block_index) as group_text
    from public.source_page_article_inventory_groups_v1 g
    join public.source_page_article_inventory_blocks_v1 b
      on b.job_id = g.job_id
     and b.block_index = any(g.block_indices)
    where g.job_id = j.id
      and g.pass_kind = v_pass
      and g.group_kind = 'article'
    group by g.group_fingerprint, g.headline_anchor, g.confidence, g.block_indices
  ),
  arts as (
    select a.id as article_id, a.analysis_body_clean
    from public.formal_corpus_articles_v1 fa
    join public.articles a
      on a.id = fa.id
    join public.source_page_capture_map_v1 cm
      on cm.source_image_id = a.source_image_id
    where cm.page_identity_source_image_id = j.page_identity_source_image_id
  ),
  scores as (
    select
      r.*,
      a.article_id,
      extensions.similarity(
        public.normalize_article_headline_v1(left(coalesce(r.group_text, ''), 4000)),
        public.normalize_article_headline_v1(left(coalesce(a.analysis_body_clean, ''), 4000))
      )::numeric as body_score
    from raw r
    cross join arts a
  ),
  ranked as (
    select
      s.*,
      row_number() over(partition by group_fingerprint order by body_score desc, article_id) as best_rank,
      body_score - lead(body_score) over(partition by group_fingerprint order by body_score desc, article_id) as body_margin
    from scores s
  ),
  assignments as (
    select *
    from ranked
    where best_rank = 1
      and body_score >= 0.08
      and coalesce(body_margin, body_score) >= 0.04
  ),
  merged as (
    select
      a.article_id,
      array_agg(distinct bi order by bi)::integer[] as block_indices,
      min(a.confidence) as confidence,
      (array_agg(a.headline_anchor order by a.body_score desc nulls last)
        filter (where coalesce(char_length(btrim(a.headline_anchor)), 0) >= 2))[1] as headline_anchor,
      jsonb_agg(jsonb_build_object(
        'source_group', a.group_fingerprint,
        'body_score', a.body_score,
        'body_margin', coalesce(a.body_margin, a.body_score)
      ) order by a.group_fingerprint) as source_groups
    from assignments a
    cross join lateral unnest(a.block_indices) bi
    group by a.article_id
  ),
  merged_texts as (
    select
      m.*,
      string_agg(b.block_text, E'\n' order by b.block_index) as merged_text
    from merged m
    join public.source_page_article_inventory_blocks_v1 b
      on b.job_id = j.id
     and b.block_index = any(m.block_indices)
    group by m.article_id, m.block_indices, m.confidence, m.headline_anchor, m.source_groups
  ),
  checks as (
    select
      mt.article_id as target_article,
      a.id as candidate_article,
      extensions.similarity(
        public.normalize_article_headline_v1(left(coalesce(mt.merged_text, ''), 4000)),
        public.normalize_article_headline_v1(left(coalesce(a.analysis_body_clean, ''), 4000))
      )::numeric as score
    from merged_texts mt
    join public.formal_corpus_articles_v1 fa on true
    join public.articles a
      on a.id = fa.id
    join public.source_page_capture_map_v1 cm
      on cm.source_image_id = a.source_image_id
     and cm.page_identity_source_image_id = j.page_identity_source_image_id
  ),
  ranked_checks as (
    select
      *,
      row_number() over(partition by target_article order by score desc, candidate_article) as check_rank,
      score - lead(score) over(partition by target_article order by score desc, candidate_article) as margin
    from checks
  )
  select count(*)::integer
    into v_bad_merged
  from ranked_checks
  where check_rank = 1
    and (
      candidate_article <> target_article
      or score < 0.08
      or coalesce(margin, score) < 0.04
    );

  if v_bad_merged <> 0 then
    raise exception 'formal_body_subset_exclusion_merged_check_failed:%', v_bad_merged;
  end if;

  with raw as (
    select
      g.group_fingerprint,
      g.headline_anchor,
      g.confidence,
      g.block_indices,
      string_agg(b.block_text, E'\n' order by b.block_index) as group_text
    from public.source_page_article_inventory_groups_v1 g
    join public.source_page_article_inventory_blocks_v1 b
      on b.job_id = g.job_id
     and b.block_index = any(g.block_indices)
    where g.job_id = j.id
      and g.pass_kind = v_pass
      and g.group_kind = 'article'
    group by g.group_fingerprint, g.headline_anchor, g.confidence, g.block_indices
  ),
  arts as (
    select a.id as article_id, a.analysis_body_clean
    from public.formal_corpus_articles_v1 fa
    join public.articles a
      on a.id = fa.id
    join public.source_page_capture_map_v1 cm
      on cm.source_image_id = a.source_image_id
    where cm.page_identity_source_image_id = j.page_identity_source_image_id
  ),
  scores as (
    select
      r.*,
      a.article_id,
      extensions.similarity(
        public.normalize_article_headline_v1(left(coalesce(r.group_text, ''), 4000)),
        public.normalize_article_headline_v1(left(coalesce(a.analysis_body_clean, ''), 4000))
      )::numeric as body_score
    from raw r
    cross join arts a
  ),
  ranked as (
    select
      s.*,
      row_number() over(partition by group_fingerprint order by body_score desc, article_id) as best_rank,
      body_score - lead(body_score) over(partition by group_fingerprint order by body_score desc, article_id) as body_margin
    from scores s
  ),
  assignments as (
    select *
    from ranked
    where best_rank = 1
      and body_score >= 0.08
      and coalesce(body_margin, body_score) >= 0.04
  ),
  merged as (
    select
      a.article_id,
      array_agg(distinct bi order by bi)::integer[] as block_indices,
      min(a.confidence) as confidence,
      (array_agg(a.headline_anchor order by a.body_score desc nulls last)
        filter (where coalesce(char_length(btrim(a.headline_anchor)), 0) >= 2))[1] as headline_anchor,
      jsonb_agg(jsonb_build_object(
        'source_group', a.group_fingerprint,
        'article_id', a.article_id,
        'body_score', a.body_score,
        'body_margin', coalesce(a.body_margin, a.body_score)
      ) order by a.group_fingerprint) as source_groups
    from assignments a
    cross join lateral unnest(a.block_indices) bi
    group by a.article_id
  ),
  article_json as (
    select
      jsonb_build_object(
        'group_kind', 'article',
        'block_indices', to_jsonb(m.block_indices),
        'headline_anchor', m.headline_anchor,
        'non_article_role', null,
        'confidence', m.confidence,
        'reason', 'formal_body_subset_exclusion_v1 assigned to current formal article ' || m.article_id::text
      ) as obj,
      m.block_indices[1] as first_block
    from merged m
  ),
  article_blocks as (
    select coalesce(array_agg(distinct bi order by bi), '{}'::integer[]) as blocks
    from merged m
    cross join lateral unnest(m.block_indices) bi
  ),
  nonarticle as (
    select array_agg(b.block_index order by b.block_index)::integer[] as blocks
    from public.source_page_article_inventory_blocks_v1 b
    cross join article_blocks ab
    where b.job_id = j.id
      and b.source_ocr_json_sha256 = j.source_ocr_json_sha256
      and not (b.block_index = any(ab.blocks))
  ),
  nonarticle_json as (
    select
      jsonb_build_object(
        'group_kind', 'non_article',
        'block_indices', to_jsonb(blocks),
        'headline_anchor', null,
        'non_article_role', 'formal_body_subset_exclusion_complement',
        'confidence', 0.99,
        'reason', 'Deterministic complement after keeping only article groups uniquely grounded to the current formal article set; API calls=0'
      ) as obj,
      coalesce(blocks[1], 2147483647) as first_block
    from nonarticle
    where cardinality(blocks) > 0
  )
  select jsonb_agg(obj order by first_block)
    into v_groups
  from (
    select * from article_json
    union all
    select * from nonarticle_json
  ) z;

  if (select count(*) from jsonb_array_elements(v_groups) x where x ->> 'group_kind' = 'article') <> j.existing_article_count then
    raise exception 'formal_body_subset_exclusion_final_article_count_mismatch';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_groups) x
    where x ->> 'group_kind' = 'article'
      and coalesce(char_length(btrim(x ->> 'headline_anchor')), 0) < 2
  ) then
    raise exception 'formal_body_subset_exclusion_missing_anchor';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(v_groups) x
    cross join lateral jsonb_array_elements_text(x -> 'block_indices') bi
  ) <> j.block_count
     or (
       select count(distinct bi::integer)
       from jsonb_array_elements(v_groups) x
       cross join lateral jsonb_array_elements_text(x -> 'block_indices') bi
     ) <> j.block_count then
    raise exception 'formal_body_subset_exclusion_partition_invalid';
  end if;

  with raw as (
    select
      g.group_fingerprint,
      g.headline_anchor,
      g.confidence,
      g.block_indices,
      string_agg(b.block_text, E'\n' order by b.block_index) as group_text
    from public.source_page_article_inventory_groups_v1 g
    join public.source_page_article_inventory_blocks_v1 b
      on b.job_id = g.job_id
     and b.block_index = any(g.block_indices)
    where g.job_id = j.id
      and g.pass_kind = v_pass
      and g.group_kind = 'article'
    group by g.group_fingerprint, g.headline_anchor, g.confidence, g.block_indices
  ),
  arts as (
    select a.id as article_id, a.analysis_body_clean
    from public.formal_corpus_articles_v1 fa
    join public.articles a
      on a.id = fa.id
    join public.source_page_capture_map_v1 cm
      on cm.source_image_id = a.source_image_id
    where cm.page_identity_source_image_id = j.page_identity_source_image_id
  ),
  scores as (
    select
      r.*,
      a.article_id,
      extensions.similarity(
        public.normalize_article_headline_v1(left(coalesce(r.group_text, ''), 4000)),
        public.normalize_article_headline_v1(left(coalesce(a.analysis_body_clean, ''), 4000))
      )::numeric as body_score
    from raw r
    cross join arts a
  ),
  ranked as (
    select
      s.*,
      row_number() over(partition by group_fingerprint order by body_score desc, article_id) as best_rank,
      body_score - lead(body_score) over(partition by group_fingerprint order by body_score desc, article_id) as body_margin
    from scores s
  ),
  assignments as (
    select *
    from ranked
    where best_rank = 1
      and body_score >= 0.08
      and coalesce(body_margin, body_score) >= 0.04
  ),
  assignment_evidence as (
    select jsonb_agg(jsonb_build_object(
      'source_group', group_fingerprint,
      'article_id', article_id,
      'body_score', body_score,
      'body_margin', coalesce(body_margin, body_score)
    ) order by article_id, group_fingerprint) as evidence
    from assignments
  )
  select coalesce(evidence, '[]'::jsonb)
    into v_assignments
  from assignment_evidence;

  v_proof := encode(extensions.digest(convert_to(
    j.id::text || '|' ||
    v_pass || '|' ||
    coalesce(v_groups::text, '[]') || '|' ||
    coalesce(v_assignments::text, '[]') || '|' ||
    'formal_body_subset_exclusion|body>=0.08|margin>=0.04|unassigned_best<0.08|min_conf>=0.80',
    'UTF8'
  ), 'sha256'), 'hex');

  v_result := public.apply_inventory_chatgpt_manual_partition_v1(
    j.id,
    v_pass,
    v_groups,
    'Deterministic formal-body subset exclusion. Selected pass ' || v_pass ||
    ' has ' || v_assigned_groups::text || ' article groups uniquely grounded to all ' ||
    j.existing_article_count::text || ' current formal articles; ' ||
    v_unassigned_groups::text || ' extra article groups have no formal-body match at body similarity >=0.08. ' ||
    'Merged articles re-pass body>=0.08 and margin>=0.04; min confidence=' ||
    coalesce(v_min_conf::text, 'null') || '; proof=' || v_proof || '; API calls=0.'
  );

  insert into public.inventory_formal_body_merge_resolution_receipts_v1(
    job_id,
    selected_pass,
    raw_article_group_count,
    merged_article_count,
    assignment_evidence,
    proof_fingerprint,
    result_status
  )
  values(
    j.id,
    v_pass,
    v_eff_groups,
    j.existing_article_count,
    coalesce(v_assignments, '[]'::jsonb),
    v_proof,
    coalesce(v_result ->> 'status', 'unknown')
  );

  return v_result || jsonb_build_object(
    'selected_pass', v_pass,
    'effective_article_groups', v_eff_groups,
    'assigned_article_groups', v_assigned_groups,
    'unassigned_article_groups', v_unassigned_groups,
    'formal_body_subset_exclusion_proof', v_proof,
    'api_calls', 0
  );
exception when others then
  update public.inventory_v3_execution_control_v1
     set enabled = false,
         grounded_third_pass_enabled = false,
         reason = 'manual API-cost stop: formal body subset exclusion failed safely',
         updated_at = now()
   where singleton = true;
  raise;
end
$function$;

revoke all on function public.resolve_inventory_review_by_formal_body_subset_exclusion_v1(uuid) from public, anon, authenticated;
grant execute on function public.resolve_inventory_review_by_formal_body_subset_exclusion_v1(uuid) to service_role;

create or replace function public.bulk_resolve_inventory_review_by_formal_body_subset_exclusion_v1(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
set statement_timeout to '240s'
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
      and j.existing_article_count >= 2
      and not exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 r where r.job_id = j.id)
      and not exists(select 1 from public.source_page_article_inventory_mappings_v2 m where m.job_id = j.id)
      and not exists(select 1 from public.source_region_materialization_receipts_v6 r where r.inventory_job_id = j.id)
    order by j.updated_at, j.id
    limit v_limit
  loop
    begin
      v_result := public.resolve_inventory_review_by_formal_body_subset_exclusion_v1(v_job.id);
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

revoke all on function public.bulk_resolve_inventory_review_by_formal_body_subset_exclusion_v1(integer) from public, anon, authenticated;
grant execute on function public.bulk_resolve_inventory_review_by_formal_body_subset_exclusion_v1(integer) to service_role;

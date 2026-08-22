create or replace function public.bulk_reuse_refreeze_completed_inventory_fast_v1(
  p_source_freeze uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
set statement_timeout to '120s'
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_enabled boolean;
  v_third boolean;
  v_current_freeze uuid;
  v_pairs integer;
  v_bad integer;
begin
  select enabled, grounded_third_pass_enabled
    into v_enabled, v_third
  from public.inventory_v3_execution_control_v1
  where singleton = true
  for update;

  if coalesce(v_enabled, true) or coalesce(v_third, true) then
    raise exception 'fast_refreeze_reuse_requires_execution_disabled';
  end if;

  select freeze_receipt_id
    into v_current_freeze
  from public.formal_corpus_freeze_gate_v2
  where freeze_gate_v2 = 'passed';

  if v_current_freeze is null or p_source_freeze is null or p_source_freeze = v_current_freeze then
    raise exception 'fast_refreeze_reuse_freeze_mismatch';
  end if;

  drop table if exists pg_temp.tmp_fast_refreeze_pairs;
  create temp table tmp_fast_refreeze_pairs on commit drop as
  select
    n.id as target_job_id,
    s.id as source_job_id,
    n.freeze_receipt_id as target_freeze_receipt_id,
    s.freeze_receipt_id as source_freeze_receipt_id,
    n.existing_article_count,
    n.block_count,
    vr.consensus_fingerprint
  from public.source_page_article_inventory_jobs_v1 n
  join public.source_page_article_inventory_jobs_v1 s
    on s.id <> n.id
   and s.freeze_receipt_id = p_source_freeze
   and s.status = 'completed'
   and s.inventory_version = n.inventory_version
   and s.page_identity_source_image_id = n.page_identity_source_image_id
   and s.inventory_source_image_id is not distinct from n.inventory_source_image_id
   and s.source_ocr_json_sha256 is not distinct from n.source_ocr_json_sha256
   and s.block_count is not distinct from n.block_count
   and s.existing_article_count is not distinct from n.existing_article_count
   and s.page_article_set_fingerprint is not distinct from n.page_article_set_fingerprint
  join public.source_page_inventory_visual_consensus_receipts_v4 vr
    on vr.job_id = s.id
   and vr.article_count = s.existing_article_count
  where n.freeze_receipt_id = v_current_freeze
    and n.status = 'queued'
    and n.inventory_version = 'page_article_inventory_v4_recovered_ocr'
    and not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id = n.id)
    and not exists(select 1 from public.source_page_article_inventory_groups_v1 g where g.job_id = n.id)
    and not exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id = n.id)
    and not exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 v where v.job_id = n.id)
    and not exists(select 1 from public.source_page_article_inventory_mappings_v2 m where m.job_id = n.id)
    and public.inventory_consensus_source_v3(s.id) is not null
    and (select count(*) from public.source_page_article_inventory_consensus_groups_v3 cg where cg.job_id = s.id) = s.existing_article_count
    and (select count(*) from public.source_page_article_inventory_mappings_v2 m where m.job_id = s.id) = s.existing_article_count
    and (select count(distinct article_id) from public.source_page_article_inventory_mappings_v2 m where m.job_id = s.id) = s.existing_article_count
    and (select count(*) from public.source_page_article_inventory_pass_runs_v1 p where p.job_id = s.id and p.pass_kind in ('mapper', 'critic', 'adjudicator')) = 3
    and (select count(distinct model) from public.source_page_article_inventory_pass_runs_v1 p where p.job_id = s.id and p.pass_kind in ('mapper', 'critic', 'adjudicator')) = 3
    and not exists (
      select 1
      from public.source_page_article_inventory_mappings_v2 m
      where m.job_id = s.id
        and m.mapping_method = 'semantic_review'
        and not (
          exists (
            select 1
            from public.source_page_inventory_semantic_mapping_receipts_v1 rr
            where rr.job_id = s.id
              and rr.group_fingerprint = m.group_fingerprint
              and rr.article_id = m.article_id
          )
          or exists (
            select 1
            from public.inventory_body_grounded_mapping_receipts_v2 br
            where br.job_id = s.id
              and br.group_fingerprint = m.group_fingerprint
              and br.article_id = m.article_id
          )
        )
    )
    and not exists (
      (select m.article_id
       from public.source_page_article_inventory_mappings_v2 m
       where m.job_id = s.id
       except
       select a.id
       from public.formal_corpus_articles_v1 a
       join public.source_page_capture_map_v1 cm
         on cm.source_image_id = a.source_image_id
       where cm.page_identity_source_image_id = n.page_identity_source_image_id)
      union all
      (select a.id
       from public.formal_corpus_articles_v1 a
       join public.source_page_capture_map_v1 cm
         on cm.source_image_id = a.source_image_id
       where cm.page_identity_source_image_id = n.page_identity_source_image_id
       except
       select m.article_id
       from public.source_page_article_inventory_mappings_v2 m
       where m.job_id = s.id)
    )
  order by n.id
  limit v_limit;

  select count(*)::integer into v_pairs from pg_temp.tmp_fast_refreeze_pairs;
  if v_pairs = 0 then
    return jsonb_build_object('reused', 0, 'api_calls', 0);
  end if;

  insert into public.source_page_article_inventory_pass_runs_v1(
    job_id,
    pass_kind,
    model,
    provider_response_id,
    prompt_sha256,
    response_sha256,
    created_at,
    source_pass_run_id
  )
  select
    p.target_job_id,
    r.pass_kind,
    r.model,
    r.provider_response_id,
    r.prompt_sha256,
    r.response_sha256,
    now(),
    coalesce(r.source_pass_run_id, r.id)
  from pg_temp.tmp_fast_refreeze_pairs p
  join public.source_page_article_inventory_pass_runs_v1 r
    on r.job_id = p.source_job_id
   and r.pass_kind in ('mapper', 'critic', 'adjudicator');

  insert into public.source_page_article_inventory_groups_v1(
    id,
    job_id,
    pass_kind,
    group_kind,
    group_fingerprint,
    block_indices,
    mapped_article_id,
    headline_anchor,
    non_article_role,
    confidence,
    reason,
    created_at
  )
  select
    gen_random_uuid(),
    p.target_job_id,
    g.pass_kind,
    g.group_kind,
    g.group_fingerprint,
    g.block_indices,
    null,
    g.headline_anchor,
    g.non_article_role,
    g.confidence,
    coalesce(g.reason, '') || '; fast_refreeze_reuse_from=' || p.source_job_id::text,
    now()
  from pg_temp.tmp_fast_refreeze_pairs p
  join public.source_page_article_inventory_groups_v1 g
    on g.job_id = p.source_job_id
   and g.pass_kind in ('mapper', 'critic', 'adjudicator');

  insert into public.source_page_inventory_visual_region_evidence_v6(
    job_id,
    pass_kind,
    article_seq,
    headline_hint,
    confidence,
    regions,
    reason,
    grounded_block_count,
    ambiguous_block_count,
    dropped_from_partition,
    model,
    provider_response_id,
    prompt_sha256,
    response_sha256,
    recorded_at
  )
  select
    p.target_job_id,
    e.pass_kind,
    e.article_seq,
    e.headline_hint,
    e.confidence,
    e.regions,
    e.reason,
    e.grounded_block_count,
    e.ambiguous_block_count,
    e.dropped_from_partition,
    e.model,
    e.provider_response_id,
    e.prompt_sha256,
    e.response_sha256,
    now()
  from pg_temp.tmp_fast_refreeze_pairs p
  join public.source_page_inventory_visual_region_evidence_v6 e
    on e.job_id = p.source_job_id
   and e.pass_kind in ('mapper', 'critic', 'adjudicator');

  insert into public.source_page_inventory_visual_consensus_receipts_v4(
    job_id,
    evidence_fingerprint,
    consensus_fingerprint,
    article_count,
    block_count,
    consensus_version,
    created_at,
    updated_at,
    baseline_requires_third_pass,
    normalization_reason
  )
  select
    p.target_job_id,
    v.evidence_fingerprint,
    v.consensus_fingerprint,
    p.existing_article_count,
    p.block_count,
    v.consensus_version || '_fast_refreeze_reuse',
    now(),
    now(),
    true,
    coalesce(v.normalization_reason, '') || '; source_job=' || p.source_job_id::text || '; exact current formal mapping set reused'
  from pg_temp.tmp_fast_refreeze_pairs p
  join public.source_page_inventory_visual_consensus_receipts_v4 v
    on v.job_id = p.source_job_id;

  insert into public.source_page_article_inventory_mappings_v2(
    job_id,
    group_fingerprint,
    article_id,
    mapping_method,
    mapping_score,
    mapping_margin,
    created_at
  )
  select
    p.target_job_id,
    m.group_fingerprint,
    m.article_id,
    m.mapping_method,
    m.mapping_score,
    m.mapping_margin,
    now()
  from pg_temp.tmp_fast_refreeze_pairs p
  join public.source_page_article_inventory_mappings_v2 m
    on m.job_id = p.source_job_id;

  insert into public.source_page_inventory_semantic_mapping_receipts_v1(
    id,
    job_id,
    group_fingerprint,
    article_id,
    shared_anchor,
    reason,
    visual_evidence_fingerprint,
    group_text_sha256,
    article_headline_sha256,
    created_at
  )
  select
    gen_random_uuid(),
    p.target_job_id,
    r.group_fingerprint,
    r.article_id,
    r.shared_anchor,
    r.reason || '; fast_refreeze_reuse_from=' || p.source_job_id::text,
    r.visual_evidence_fingerprint,
    r.group_text_sha256,
    r.article_headline_sha256,
    now()
  from pg_temp.tmp_fast_refreeze_pairs p
  join public.source_page_inventory_semantic_mapping_receipts_v1 r
    on r.job_id = p.source_job_id
  on conflict (job_id, group_fingerprint) do nothing;

  insert into public.inventory_body_grounded_mapping_receipts_v2(
    id,
    job_id,
    group_fingerprint,
    article_id,
    clean_body_similarity,
    next_best_clean_body_similarity,
    clean_body_similarity_margin,
    group_text_sha256,
    article_analysis_body_clean_sha256,
    article_analysis_body_clean_version,
    reason,
    created_at
  )
  select
    gen_random_uuid(),
    p.target_job_id,
    r.group_fingerprint,
    r.article_id,
    r.clean_body_similarity,
    r.next_best_clean_body_similarity,
    r.clean_body_similarity_margin,
    r.group_text_sha256,
    r.article_analysis_body_clean_sha256,
    r.article_analysis_body_clean_version,
    r.reason || '; fast_refreeze_reuse_from=' || p.source_job_id::text,
    now()
  from pg_temp.tmp_fast_refreeze_pairs p
  join public.inventory_body_grounded_mapping_receipts_v2 r
    on r.job_id = p.source_job_id
  on conflict (job_id, group_fingerprint) do nothing;

  insert into public.inventory_post_discovery_refreeze_reuse_receipts_v1(
    target_job_id,
    source_job_id,
    target_freeze_receipt_id,
    source_freeze_receipt_id,
    source_visual_consensus_fingerprint,
    source_manual_partition_receipt_ids,
    source_semantic_repartition_receipt_ids,
    mapped_article_count,
    proof_fingerprint
  )
  select
    p.target_job_id,
    p.source_job_id,
    p.target_freeze_receipt_id,
    p.source_freeze_receipt_id,
    p.consensus_fingerprint,
    coalesce(mp.manual_ids, '{}'::uuid[]),
    coalesce(sr.repartition_ids, '{}'::uuid[]),
    p.existing_article_count,
    encode(extensions.digest(convert_to(
      p.target_job_id::text || '|' ||
      p.source_job_id::text || '|' ||
      p.target_freeze_receipt_id::text || '|' ||
      p.source_freeze_receipt_id::text || '|' ||
      p.existing_article_count::text || '|' ||
      p.consensus_fingerprint || '|' ||
      coalesce(mm.mapping_fingerprint, ''),
      'UTF8'
    ), 'sha256'), 'hex')
  from pg_temp.tmp_fast_refreeze_pairs p
  left join lateral (
    select array_agg(job_id order by job_id) as manual_ids
    from public.inventory_chatgpt_manual_partition_receipts_v1
    where job_id = p.source_job_id
  ) mp on true
  left join lateral (
    select array_agg(id order by id) as repartition_ids
    from public.inventory_semantic_repartition_receipts_v1
    where job_id = p.source_job_id
  ) sr on true
  left join lateral (
    select string_agg(group_fingerprint || ':' || article_id::text, '|' order by group_fingerprint) as mapping_fingerprint
    from public.source_page_article_inventory_mappings_v2
    where job_id = p.source_job_id
  ) mm on true
  on conflict (target_job_id) do nothing;

  select count(*)::integer
    into v_bad
  from pg_temp.tmp_fast_refreeze_pairs p
  where public.inventory_consensus_source_v3(p.target_job_id) is null
     or (select count(*) from public.source_page_article_inventory_consensus_groups_v3 cg where cg.job_id = p.target_job_id) <> p.existing_article_count
     or (select count(*) from public.source_page_article_inventory_mappings_v2 m where m.job_id = p.target_job_id) <> p.existing_article_count
     or (select count(distinct article_id) from public.source_page_article_inventory_mappings_v2 m where m.job_id = p.target_job_id) <> p.existing_article_count
     or jsonb_array_length(public.inventory_mapping_grounding_violations_v1(p.target_job_id)) <> 0
     or jsonb_array_length(public.inventory_structural_article_group_violations_v1(p.target_job_id)) <> 0;

  if v_bad <> 0 then
    raise exception 'fast_refreeze_reuse_post_validation_failed:%', v_bad;
  end if;

  update public.source_page_article_inventory_jobs_v1 j
     set status = 'completed',
         requires_third_pass = true,
         lease_token = null,
         lease_expires_at = null,
         error_message = null,
         finished_at = now(),
         updated_at = now()
  from pg_temp.tmp_fast_refreeze_pairs p
  where j.id = p.target_job_id
    and j.status = 'queued';

  return jsonb_build_object('reused', v_pairs, 'api_calls', 0, 'source_freeze', p_source_freeze, 'target_freeze', v_current_freeze);
exception when others then
  update public.inventory_v3_execution_control_v1
     set enabled = false,
         grounded_third_pass_enabled = false,
         reason = 'manual API-cost stop: fast refreeze reuse failed safely',
         updated_at = now()
   where singleton = true;
  raise;
end
$function$;

revoke all on function public.bulk_reuse_refreeze_completed_inventory_fast_v1(uuid, integer) from public, anon, authenticated;
grant execute on function public.bulk_reuse_refreeze_completed_inventory_fast_v1(uuid, integer) to service_role;

create or replace function public.ensure_inventory_completion_consensus_receipt_v2(p_job_id uuid, p_existing_article_count integer, p_block_count integer, p_requires_third_pass boolean)
returns void
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  r public.source_page_inventory_visual_consensus_receipts_v4%rowtype;
  v_expected integer;
  v_passes integer;
  v_models integer;
  v_responses integer;
  v_prompts integer;
  v_groups integer;
  v_maps integer;
  v_articles integer;
  v_grounding jsonb;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id;
  if not found then raise exception 'inventory_completion_guard_job_missing'; end if;
  if j.inventory_version<>'page_article_inventory_v4_recovered_ocr' then return; end if;
  if j.existing_article_count is distinct from p_existing_article_count or j.block_count is distinct from p_block_count or j.requires_third_pass is distinct from p_requires_third_pass then raise exception 'inventory_completion_guard_job_arguments_mismatch'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'inventory_completion_guard_freeze_stale'; end if;
  select * into r from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=p_job_id;
  if not found then
    perform public.ensure_inventory_completion_consensus_receipt_v1(p_job_id,p_existing_article_count,p_block_count,p_requires_third_pass);
    select * into r from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=p_job_id;
    if not found then raise exception 'inventory_completion_guard_receipt_creation_failed'; end if;
  end if;
  v_expected:=case when coalesce(p_requires_third_pass,false) then 3 else 2 end;
  select count(*)::integer,count(distinct model)::integer,count(distinct provider_response_id)::integer,count(distinct prompt_sha256)::integer into v_passes,v_models,v_responses,v_prompts from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id and pass_kind in ('mapper','critic','adjudicator');
  if v_passes<>v_expected or v_models<>v_expected or v_responses<>v_expected or v_prompts<>v_expected then raise exception 'inventory_completion_guard_independent_passes_incomplete'; end if;
  if not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id and pass_kind='mapper') or not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id and pass_kind='critic') or (p_requires_third_pass and not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id and pass_kind='adjudicator')) then raise exception 'inventory_completion_guard_required_pass_kind_missing'; end if;
  if exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=p_job_id and p.pass_kind in ('mapper','critic','adjudicator') and (coalesce(p.model,'')='' or coalesce(p.provider_response_id,'')='' or coalesce(p.prompt_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p.response_sha256,'') !~ '^[0-9a-f]{64}$')) then raise exception 'inventory_completion_guard_pass_lineage_invalid'; end if;
  if exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=p_job_id and p.pass_kind in ('mapper','critic','adjudicator') and not exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=p.job_id and e.pass_kind=p.pass_kind and e.model=p.model and e.provider_response_id=p.provider_response_id and e.prompt_sha256=p.prompt_sha256 and e.response_sha256=p.response_sha256)) then raise exception 'inventory_completion_guard_region_evidence_lineage_missing'; end if;
  if exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=p_job_id and e.pass_kind in ('mapper','critic','adjudicator') and not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=e.job_id and p.pass_kind=e.pass_kind and p.model=e.model and p.provider_response_id=e.provider_response_id and p.prompt_sha256=e.prompt_sha256 and p.response_sha256=e.response_sha256)) then raise exception 'inventory_completion_guard_orphan_region_evidence'; end if;
  if exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=p_job_id and p.pass_kind in ('mapper','critic','adjudicator') and exists((select b.block_index from public.source_page_article_inventory_blocks_v1 b where b.job_id=p_job_id and b.source_ocr_json_sha256=j.source_ocr_json_sha256 except select bi from public.source_page_article_inventory_groups_v1 g cross join lateral unnest(g.block_indices) bi where g.job_id=p_job_id and g.pass_kind=p.pass_kind) union all (select bi from public.source_page_article_inventory_groups_v1 g cross join lateral unnest(g.block_indices) bi where g.job_id=p_job_id and g.pass_kind=p.pass_kind except select b.block_index from public.source_page_article_inventory_blocks_v1 b where b.job_id=p_job_id and b.source_ocr_json_sha256=j.source_ocr_json_sha256))) then raise exception 'inventory_completion_guard_partition_block_set_mismatch'; end if;
  if exists(select 1 from (select p.pass_kind,(select count(*)::integer from public.source_page_article_inventory_groups_v1 g cross join lateral unnest(g.block_indices) bi where g.job_id=p_job_id and g.pass_kind=p.pass_kind) assigned,(select count(distinct bi)::integer from public.source_page_article_inventory_groups_v1 g cross join lateral unnest(g.block_indices) bi where g.job_id=p_job_id and g.pass_kind=p.pass_kind) covered from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=p_job_id and p.pass_kind in ('mapper','critic','adjudicator')) q where q.assigned<>p_block_count or q.covered<>p_block_count) then raise exception 'inventory_completion_guard_partition_not_bijective'; end if;
  if r.block_count<>p_block_count or coalesce(r.evidence_fingerprint,'') !~ '^[0-9a-f]{64}$' or coalesce(r.consensus_fingerprint,'') !~ '^[0-9a-f]{64}$' then raise exception 'inventory_completion_guard_existing_receipt_invalid'; end if;
  if public.inventory_consensus_source_v3(p_job_id) is null then raise exception 'inventory_completion_guard_consensus_missing'; end if;
  select count(*)::integer into v_groups from public.source_page_article_inventory_consensus_groups_v3 where job_id=p_job_id;
  select count(*)::integer,count(distinct article_id)::integer into v_maps,v_articles from public.source_page_article_inventory_mappings_v2 where job_id=p_job_id;
  if v_groups<>p_existing_article_count or v_maps<>p_existing_article_count or v_articles<>p_existing_article_count then raise exception 'inventory_completion_guard_effective_consensus_invalid'; end if;
  if exists((select g.group_fingerprint from public.source_page_article_inventory_consensus_groups_v3 g where g.job_id=p_job_id except select m.group_fingerprint from public.source_page_article_inventory_mappings_v2 m where m.job_id=p_job_id) union all (select m.group_fingerprint from public.source_page_article_inventory_mappings_v2 m where m.job_id=p_job_id except select g.group_fingerprint from public.source_page_article_inventory_consensus_groups_v3 g where g.job_id=p_job_id)) then raise exception 'inventory_completion_guard_mapping_consensus_set_mismatch'; end if;
  if exists((select m.article_id from public.source_page_article_inventory_mappings_v2 m where m.job_id=p_job_id except select a.id from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id) union all (select a.id from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id except select m.article_id from public.source_page_article_inventory_mappings_v2 m where m.job_id=p_job_id)) then raise exception 'inventory_completion_guard_mapping_article_set_mismatch'; end if;
  v_grounding:=public.inventory_mapping_grounding_violations_v1(p_job_id);
  if jsonb_array_length(coalesce(v_grounding,'[]'::jsonb))>0 then raise exception 'inventory_completion_guard_mapping_grounding_invalid'; end if;
end
$function$;

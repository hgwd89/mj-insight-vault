create or replace function public.ensure_inventory_completion_consensus_receipt_v2(p_job_id uuid,p_existing_article_count integer,p_block_count integer,p_requires_third_pass boolean)
returns void
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  r public.source_page_inventory_visual_consensus_receipts_v4%rowtype;
  v_expected integer;
  v_passes integer;
  v_models integer;
  v_responses integer;
  v_prompts integer;
  v_groups integer;
  v_maps integer;
  v_articles integer;
begin
  select * into r from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=p_job_id;
  if not found then
    perform public.ensure_inventory_completion_consensus_receipt_v1(p_job_id,p_existing_article_count,p_block_count,p_requires_third_pass);
    return;
  end if;

  v_expected:=case when coalesce(p_requires_third_pass,false) then 3 else 2 end;
  select count(*)::integer,count(distinct model)::integer,count(distinct provider_response_id)::integer,count(distinct prompt_sha256)::integer
    into v_passes,v_models,v_responses,v_prompts
  from public.source_page_article_inventory_pass_runs_v1
  where job_id=p_job_id and pass_kind in ('mapper','critic','adjudicator');
  if v_passes<>v_expected or v_models<>v_expected or v_responses<>v_expected or v_prompts<>v_expected then
    raise exception 'inventory_completion_guard_independent_passes_incomplete';
  end if;
  if not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id and pass_kind='mapper')
     or not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id and pass_kind='critic')
     or (p_requires_third_pass and not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id and pass_kind='adjudicator')) then
    raise exception 'inventory_completion_guard_required_pass_kind_missing';
  end if;
  if exists(
    select 1 from public.source_page_article_inventory_pass_runs_v1 p
    where p.job_id=p_job_id and p.pass_kind in ('mapper','critic','adjudicator')
      and not exists(
        select 1 from public.source_page_inventory_visual_region_evidence_v6 e
        where e.job_id=p.job_id and e.pass_kind=p.pass_kind and e.model=p.model
          and e.provider_response_id=p.provider_response_id and e.prompt_sha256=p.prompt_sha256
          and e.response_sha256=p.response_sha256
      )
  ) then raise exception 'inventory_completion_guard_region_evidence_lineage_missing'; end if;
  if exists(
    select 1 from (
      select p.pass_kind,
        (select count(distinct bi)::integer from public.source_page_article_inventory_groups_v1 g cross join lateral unnest(g.block_indices) bi where g.job_id=p_job_id and g.pass_kind=p.pass_kind) covered,
        (select count(*)::integer from public.source_page_article_inventory_groups_v1 g cross join lateral unnest(g.block_indices) bi where g.job_id=p_job_id and g.pass_kind=p.pass_kind) assigned
      from public.source_page_article_inventory_pass_runs_v1 p
      where p.job_id=p_job_id and p.pass_kind in ('mapper','critic','adjudicator')
    ) q where q.covered<>p_block_count or q.assigned<>p_block_count
  ) then raise exception 'inventory_completion_guard_partition_not_bijective'; end if;
  if r.block_count<>p_block_count or coalesce(r.evidence_fingerprint,'') !~ '^[0-9a-f]{64}$' or coalesce(r.consensus_fingerprint,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'inventory_completion_guard_existing_receipt_invalid';
  end if;
  select count(*)::integer into v_groups from public.source_page_article_inventory_consensus_groups_v3 where job_id=p_job_id;
  select count(*)::integer,count(distinct article_id)::integer into v_maps,v_articles from public.source_page_article_inventory_mappings_v2 where job_id=p_job_id;
  if public.inventory_consensus_source_v3(p_job_id) is null or v_groups<>p_existing_article_count or v_maps<>p_existing_article_count or v_articles<>p_existing_article_count then
    raise exception 'inventory_completion_guard_effective_consensus_invalid';
  end if;
end
$function$;

create or replace function public.enforce_inventory_state_contract_v3()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare v_enabled boolean;
begin
  if tg_op='UPDATE' then
    if old.state_contract_version>=2 and new.state_contract_version<old.state_contract_version then raise exception 'inventory_state_contract_version_cannot_downgrade'; end if;
    if old.state_contract_version>=2 and new.baseline_requires_third_pass is distinct from old.baseline_requires_third_pass then raise exception 'inventory_baseline_requires_third_pass_is_immutable'; end if;
  end if;
  if new.state_contract_version>=2 and new.baseline_requires_third_pass and not new.requires_third_pass then raise exception 'inventory_state_contract_v2_baseline_third_must_remain_required'; end if;
  if new.state_contract_version>=2 and new.inventory_version='page_article_inventory_v4_recovered_ocr' and new.status='completed' then
    if tg_op='INSERT' then raise exception 'inventory_completed_insert_not_allowed'; end if;
    if old.status is distinct from 'completed' then
      select enabled into v_enabled from public.inventory_v3_execution_control_v1 where singleton=true;
      if not coalesce(v_enabled,false) then raise exception 'inventory_completion_blocked_execution_control_disabled'; end if;
      perform public.ensure_inventory_completion_consensus_receipt_v2(new.id,new.existing_article_count,new.block_count,new.requires_third_pass);
    elsif not exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 c where c.job_id=new.id) then
      raise exception 'inventory_completed_state_consensus_receipt_missing';
    end if;
  end if;
  return new;
end
$function$;

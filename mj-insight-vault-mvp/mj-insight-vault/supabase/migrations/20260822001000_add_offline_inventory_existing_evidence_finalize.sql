create or replace function public.finalize_inventory_offline_queued_existing_evidence_strict_v1(
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  c public.source_page_article_inventory_jobs_v1%rowtype;
  v_enabled boolean;
  v_third boolean;
  v_freeze uuid;
  v_passes integer;
  v_models integer;
  v_responses integer;
  v_prompts integer;
  v_groups integer;
  v_consensus_source text;
  v_result jsonb;
begin
  select enabled, grounded_third_pass_enabled
    into v_enabled, v_third
  from public.inventory_v3_execution_control_v1
  where singleton=true
  for update;

  if coalesce(v_enabled,true) or coalesce(v_third,true) then
    raise exception 'offline_existing_evidence_finalize_requires_execution_disabled';
  end if;

  select freeze_receipt_id
    into v_freeze
  from public.formal_corpus_freeze_gate_v2
  where freeze_gate_v2='passed';

  if v_freeze is null then
    raise exception 'offline_existing_evidence_finalize_freeze_not_passed';
  end if;

  select *
    into j
  from public.source_page_article_inventory_jobs_v1
  where id=p_job_id
  for update;

  if not found
     or j.status<>'queued'
     or j.freeze_receipt_id is distinct from v_freeze
     or j.inventory_version<>'page_article_inventory_v4_recovered_ocr'
     or not j.requires_third_pass
     or not public.inventory_recovered_job_identity_ok_v1(j.id,v_freeze) then
    raise exception 'offline_existing_evidence_finalize_job_not_eligible';
  end if;

  if exists(select 1 from public.source_region_materialization_receipts_v6 r where r.inventory_job_id=j.id) then
    raise exception 'offline_existing_evidence_finalize_materialized_job';
  end if;

  select count(*)::integer,
         count(distinct model)::integer,
         count(distinct provider_response_id)::integer,
         count(distinct prompt_sha256)::integer
    into v_passes, v_models, v_responses, v_prompts
  from public.source_page_article_inventory_pass_runs_v1
  where job_id=j.id
    and pass_kind in ('mapper','critic','adjudicator');

  if v_passes<>3
     or v_models<>3
     or v_responses<>3
     or v_prompts<>3
     or not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id and pass_kind='mapper')
     or not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id and pass_kind='critic')
     or not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id and pass_kind='adjudicator') then
    raise exception 'offline_existing_evidence_finalize_three_independent_passes_required';
  end if;

  v_consensus_source := public.inventory_consensus_source_v3(j.id);
  if v_consensus_source is null then
    raise exception 'offline_existing_evidence_finalize_consensus_missing';
  end if;

  select count(*)::integer
    into v_groups
  from public.source_page_article_inventory_consensus_groups_v3
  where job_id=j.id;

  if v_groups<>j.existing_article_count then
    raise exception 'offline_existing_evidence_finalize_article_count_mismatch:%/%',
      v_groups, j.existing_article_count;
  end if;

  if jsonb_array_length(public.inventory_structural_article_group_violations_v1(j.id))<>0 then
    raise exception 'offline_existing_evidence_finalize_structural_violation';
  end if;

  if jsonb_array_length(public.inventory_mapping_grounding_violations_v1(j.id))<>0 then
    raise exception 'offline_existing_evidence_finalize_mapping_grounding_violation';
  end if;

  update public.inventory_v3_execution_control_v1
     set enabled=true,
         grounded_third_pass_enabled=true,
         reason='transaction-local strict finalize of queued existing three-pass evidence; no API',
         updated_at=now()
   where singleton=true;

  select *
    into c
  from public.claim_source_page_article_inventory_job_v3(j.id,300)
  limit 1;

  if c.id is null then
    raise exception 'offline_existing_evidence_finalize_claim_failed';
  end if;

  v_result := public.finalize_source_page_article_inventory_job_v3(c.id,c.lease_token);

  if coalesce(v_result->>'status','')<>'completed' then
    raise exception 'offline_existing_evidence_finalize_not_completed:%', v_result::text;
  end if;

  update public.inventory_v3_execution_control_v1
     set enabled=false,
         grounded_third_pass_enabled=false,
         reason='manual API-cost stop: Inventory decisions are being completed without OpenAI API',
         updated_at=now()
   where singleton=true;

  return v_result || jsonb_build_object(
    'offline_existing_evidence', true,
    'consensus_source', v_consensus_source,
    'api_calls', 0
  );
exception when others then
  update public.inventory_v3_execution_control_v1
     set enabled=false,
         grounded_third_pass_enabled=false,
         reason='manual API-cost stop: Inventory decisions are being completed without OpenAI API',
         updated_at=now()
   where singleton=true;
  raise;
end
$function$;

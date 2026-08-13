create or replace function public.reopen_inventory_structurally_invalid_completed_v1(p_job_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_violations jsonb;
  v_partition uuid;
  v_clear public.inventory_partition_dependency_clearance_v1%rowtype;
begin
  if exists(select 1 from public.inventory_v3_execution_control_v1 where singleton=true and enabled) then
    raise exception 'structural_completed_reopen_requires_execution_disabled';
  end if;

  select * into j
  from public.source_page_article_inventory_jobs_v1
  where id=p_job_id
  for update;

  if not found or j.status<>'completed' then
    raise exception 'structural_completed_reopen_requires_completed';
  end if;
  if j.freeze_receipt_id is distinct from (select freeze_receipt_id from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then
    raise exception 'structural_completed_reopen_requires_current_freeze';
  end if;

  v_violations:=public.inventory_structural_article_group_violations_v1(j.id);
  if jsonb_array_length(v_violations)=0 then
    raise exception 'structural_completed_reopen_no_violation';
  end if;

  select partition_job_id into v_partition
  from public.source_region_materialization_receipts_v6
  where inventory_job_id=j.id;
  if v_partition is null then
    raise exception 'structural_completed_reopen_materialization_receipt_missing';
  end if;

  select * into v_clear
  from public.inventory_partition_dependency_clearance_v1
  where partition_job_id=v_partition
    and inventory_job_id=j.id
    and checked_at>now()-interval '30 minutes';
  if not found then
    raise exception 'structural_completed_reopen_dependency_clearance_missing';
  end if;
  if v_clear.non_core_reference_count<>0 then
    raise exception 'structural_completed_reopen_downstream_dependencies:%',v_clear.non_core_reference_count;
  end if;

  insert into public.inventory_structural_completed_reopen_archives_v1(
    job_id,reason,structural_violations,job_snapshot,pass_runs,current_groups,visual_group_evidence,
    visual_region_evidence,mappings,mapping_pass_runs,final_consensus_receipt,two_pass_receipt,
    materialization_receipt,partition_job,block_assignments,article_source_regions
  )
  select j.id,p_reason,v_violations,to_jsonb(j),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind) from public.source_page_article_inventory_pass_runs_v1 x where x.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind,x.group_fingerprint) from public.source_page_article_inventory_groups_v1 x where x.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind,x.original_group_fingerprint) from public.source_page_inventory_visual_group_evidence_v4 x where x.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind,x.article_seq) from public.source_page_inventory_visual_region_evidence_v6 x where x.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.group_fingerprint) from public.source_page_article_inventory_mappings_v2 x where x.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.pass_kind) from public.source_page_article_inventory_mapping_pass_runs_v2 x where x.job_id=j.id),'[]'::jsonb),
    (select to_jsonb(x) from public.source_page_inventory_visual_consensus_receipts_v4 x where x.job_id=j.id),
    (select to_jsonb(x) from public.source_page_inventory_two_pass_normalization_receipts_v1 x where x.job_id=j.id),
    (select to_jsonb(x) from public.source_region_materialization_receipts_v6 x where x.inventory_job_id=j.id),
    (select to_jsonb(x) from public.source_page_partition_jobs_v3 x where x.id=v_partition),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.block_index) from public.source_inventory_block_assignments_v7 x where x.inventory_job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(x) order by x.article_id) from public.article_source_regions x where x.partition_job_id=v_partition),'[]'::jsonb)
  on conflict(job_id,reason) do nothing;

  -- Completed proofs become mutable only after the job leaves the completed state.
  -- The whole function is one transaction, so any later failure rolls this transition back.
  update public.source_page_article_inventory_jobs_v1
  set status='queued',requires_third_pass=true,lease_token=null,lease_expires_at=null,
      error_message=null,finished_at=null,attempt_count=0,updated_at=now()
  where id=j.id;

  delete from public.article_source_regions where partition_job_id=v_partition;
  delete from public.source_inventory_block_assignments_v7 where inventory_job_id=j.id;
  delete from public.source_region_materialization_receipts_v6 where inventory_job_id=j.id;
  delete from public.inventory_partition_dependency_clearance_v1 where partition_job_id=v_partition;
  delete from public.source_page_partition_jobs_v3 where id=v_partition;

  delete from public.inventory_body_grounded_mapping_receipts_v1 where job_id=j.id;
  delete from public.inventory_body_grounded_mapping_receipts_v2 where job_id=j.id;
  delete from public.source_page_inventory_semantic_mapping_receipts_v1 where job_id=j.id;
  delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mappings_v2 where job_id=j.id;
  delete from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=j.id;
  delete from public.source_page_inventory_two_pass_normalization_receipts_v1 where job_id=j.id;
  delete from public.source_page_inventory_visual_group_evidence_v4 where job_id=j.id;
  delete from public.source_page_inventory_visual_region_evidence_v6 where job_id=j.id;
  delete from public.source_page_article_inventory_groups_v1 where job_id=j.id;
  delete from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id;

  return jsonb_build_object(
    'status','queued',
    'job_id',j.id,
    'requires_third_pass',true,
    'structural_violations',v_violations,
    'raw_visual_reacquisition',true
  );
end
$function$;

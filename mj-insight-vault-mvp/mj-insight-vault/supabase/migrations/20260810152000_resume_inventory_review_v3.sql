begin;

create or replace function public.resume_source_page_article_inventory_review_v3(
  p_job_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_run_count integer;
  v_mapper_count integer;
  v_critic_count integer;
  v_adjudicator_count integer;
  v_model_count integer;
  v_response_count integer;
  v_prompt_count integer;
  v_mapper_block_count integer;
  v_critic_block_count integer;
begin
  if not exists(
    select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed'
  ) then
    raise exception 'inventory_v3_freeze_stale';
  end if;

  select * into j
    from public.source_page_article_inventory_jobs_v1
   where id=p_job_id
   for update;
  if not found then
    raise exception 'inventory_v3_resume_job_not_found';
  end if;
  if j.status<>'needs_review' then
    raise exception 'inventory_v3_resume_requires_needs_review_status';
  end if;

  select count(*)::integer,
         count(*) filter(where pass_kind='mapper')::integer,
         count(*) filter(where pass_kind='critic')::integer,
         count(*) filter(where pass_kind='adjudicator')::integer,
         count(distinct model)::integer,
         count(distinct provider_response_id)::integer,
         count(distinct prompt_sha256)::integer
    into v_run_count,v_mapper_count,v_critic_count,v_adjudicator_count,
         v_model_count,v_response_count,v_prompt_count
    from public.source_page_article_inventory_pass_runs_v1
   where job_id=p_job_id;

  if v_run_count<>2 or v_mapper_count<>1 or v_critic_count<>1 or v_adjudicator_count<>0 then
    raise exception 'inventory_v3_resume_requires_exact_mapper_critic_receipts';
  end if;
  if v_model_count<>2 or v_response_count<>2 or v_prompt_count<>2 then
    raise exception 'inventory_v3_resume_passes_not_independent';
  end if;

  select count(distinct x.block_index)::integer
    into v_mapper_block_count
    from public.source_page_article_inventory_groups_v1 g
    cross join lateral unnest(g.block_indices) x(block_index)
   where g.job_id=p_job_id and g.pass_kind='mapper';
  select count(distinct x.block_index)::integer
    into v_critic_block_count
    from public.source_page_article_inventory_groups_v1 g
    cross join lateral unnest(g.block_indices) x(block_index)
   where g.job_id=p_job_id and g.pass_kind='critic';

  if v_mapper_block_count<>j.block_count or v_critic_block_count<>j.block_count then
    raise exception 'inventory_v3_resume_pass_partition_incomplete';
  end if;

  if exists(
    select 1
      from public.source_page_article_inventory_mapping_pass_runs_v2
     where job_id=p_job_id
  ) or exists(
    select 1
      from public.source_page_article_inventory_mappings_v2
     where job_id=p_job_id
  ) then
    raise exception 'inventory_v3_resume_mapping_proofs_must_be_empty';
  end if;

  update public.source_page_article_inventory_jobs_v1
     set status='queued',
         requires_third_pass=true,
         lease_token=null,
         lease_expires_at=null,
         error_message=null,
         finished_at=null,
         updated_at=now()
   where id=p_job_id;

  return jsonb_build_object(
    'status','queued',
    'preserved_blind_receipts',2,
    'requires_third_pass',true,
    'next_stage','blind_adjudicator_v3'
  );
end
$function$;

revoke all on function public.resume_source_page_article_inventory_review_v3(uuid)
  from public,anon,authenticated;
grant execute on function public.resume_source_page_article_inventory_review_v3(uuid)
  to service_role;

commit;

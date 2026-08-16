create or replace function public.prepare_inventory_majority_n_retry_v1()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_freeze uuid;
  v_enabled boolean;
  v_third boolean;
  v_job uuid;
begin
  select freeze_receipt_id into v_freeze
  from public.formal_corpus_freeze_gate_v2
  where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'inventory_majority_n_retry_no_current_freeze'; end if;

  select enabled,grounded_third_pass_enabled into v_enabled,v_third
  from public.inventory_v3_execution_control_v1
  where singleton=true and freeze_receipt_id=v_freeze;
  if not coalesce(v_enabled,false) or not coalesce(v_third,false) then
    raise exception 'inventory_majority_n_retry_execution_not_ready';
  end if;

  select j.id into v_job
  from public.source_page_article_inventory_jobs_v1 j
  where j.freeze_receipt_id=v_freeze
    and j.inventory_version='page_article_inventory_v4_recovered_ocr'
    and public.inventory_recovered_job_identity_ok_v1(j.id,v_freeze)
    and j.status='needs_review'
    and j.error_message='One-model-only visual article has no independent support.'
    and exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id and p.pass_kind='mapper' and p.model='gpt-4.1')
    and exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id and p.pass_kind='critic' and p.model='gpt-4o')
    and exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id and p.pass_kind='adjudicator' and p.model='gpt-5.6-sol')
    and not exists(select 1 from public.source_region_materialization_receipts_v6 r where r.inventory_job_id=j.id)
    and not exists(select 1 from public.source_page_article_inventory_mappings_v2 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_article_inventory_mapping_pass_runs_v2 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_inventory_two_pass_normalization_receipts_v1 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_inventory_visual_group_evidence_v4 r where r.job_id=j.id)
    and not exists(select 1 from public.inventory_semantic_repartition_receipts_v1 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_inventory_semantic_group_consolidation_receipts_v1 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_inventory_semantic_overrides_v1 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_inventory_recovered_headline_overrides_v1 r where r.job_id=j.id)
    and not exists(select 1 from public.source_page_inventory_visual_exclusions_v1 r where r.job_id=j.id)
    and not exists(select 1 from public.inventory_group_semantic_exclusion_receipts_v1 r where r.job_id=j.id)
    and exists(
      select 1
      from public.source_page_article_inventory_groups_v1 a
      where a.job_id=j.id and a.group_kind='article'
        and (
          select count(*)
          from (values ('mapper'::text),('critic'::text),('adjudicator'::text)) p(pass_kind)
          where p.pass_kind<>a.pass_kind
            and not exists(
              select 1 from unnest(a.block_indices) bi
              where not exists(
                select 1 from public.source_page_article_inventory_groups_v1 n
                where n.job_id=a.job_id
                  and n.pass_kind=p.pass_kind
                  and n.group_kind='non_article'
                  and bi=any(n.block_indices)
              )
            )
        )=2
    )
  order by j.updated_at,j.id
  for update of j skip locked
  limit 1;

  if v_job is null then
    return jsonb_build_object('prepared',false,'job_id',null,'reason','no_eligible_majority_n_review');
  end if;

  update public.source_page_article_inventory_jobs_v1
  set status='queued',lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now()
  where id=v_job;

  return jsonb_build_object('prepared',true,'job_id',v_job,'proofs_preserved',true);
end
$function$;

revoke all on function public.prepare_inventory_majority_n_retry_v1() from public,anon,authenticated;
grant execute on function public.prepare_inventory_majority_n_retry_v1() to service_role;

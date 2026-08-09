begin;

create or replace function public.resolve_inventory_mapping_auto_v2(p_job_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public,extensions
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;v_groups integer;v_resolved integer;
begin
 select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
 if not found then raise exception 'inventory_mapping_v3_job_missing'; end if;
 delete from public.source_page_article_inventory_mappings_v2 where job_id=j.id and mapping_method='auto_reciprocal_headline';
 select count(*)::integer into v_groups from public.source_page_article_inventory_consensus_groups_v2 where job_id=j.id;
 insert into public.source_page_article_inventory_mappings_v2(job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin)
 select j.id,c.group_fingerprint,c.article_id,'auto_reciprocal_headline',c.score,c.group_margin
 from public.inventory_mapping_candidates_v2(j.id) c
 join public.source_page_article_inventory_consensus_groups_v2 g on g.job_id=j.id and g.group_fingerprint=c.group_fingerprint
 join public.formal_corpus_articles_v1 a on a.id=c.article_id
 where c.group_rank=1 and c.article_rank=1
   and c.score>=0.30 and c.group_margin>=0.05
   and similarity(public.normalize_article_headline_v1(a.headline),public.normalize_article_headline_v1(g.headline_anchor))>=0.20
 on conflict(job_id,group_fingerprint) do nothing;
 get diagnostics v_resolved=row_count;
 return jsonb_build_object('group_count',v_groups,'auto_resolved',v_resolved,'unresolved',v_groups-(select count(*) from public.source_page_article_inventory_mappings_v2 where job_id=j.id));
end
$function$;

-- These jobs were never executed and have no proposals, pass receipts, grounding reviews, or regions.
delete from public.source_page_partition_jobs_v3
where partition_version='source_block_partition_v3_page_identity'
  and status='queued'
  and not exists(select 1 from public.source_page_partition_proposals_v3 p where p.job_id=source_page_partition_jobs_v3.id)
  and not exists(select 1 from public.source_page_partition_pass_runs_v3 p where p.job_id=source_page_partition_jobs_v3.id)
  and not exists(select 1 from public.article_source_regions r where r.partition_job_id=source_page_partition_jobs_v3.id);

-- The formal pipeline no longer performs a second LLM page partition after blind Inventory.
revoke execute on function public.claim_source_page_partition_job_v5(integer) from service_role;
revoke execute on function public.claim_source_page_partition_job_v4(integer) from service_role;
revoke execute on function public.claim_source_page_partition_job_v3(integer) from service_role;
revoke execute on function public.renew_source_page_partition_job_lease_v4(uuid,uuid,integer) from service_role;
revoke execute on function public.renew_source_page_partition_job_lease_v3(uuid,uuid,integer) from service_role;
revoke execute on function public.replace_source_page_partition_proposals_v4(uuid,uuid,text,text,text,text,text,jsonb) from service_role;
revoke execute on function public.replace_source_page_partition_proposals_v3(uuid,uuid,text,jsonb) from service_role;
revoke execute on function public.finalize_source_page_partition_job_v4(uuid,uuid) from service_role;
revoke execute on function public.finalize_source_page_partition_job_v3(uuid,uuid,text,text) from service_role;
revoke execute on function public.replace_article_source_grounding_reviews_v4(uuid,uuid,text,text,text,text,jsonb) from service_role;
revoke execute on function public.replace_article_source_grounding_reviews_v3(uuid,uuid,jsonb) from service_role;
revoke execute on function public.fail_source_page_partition_job_v3(uuid,uuid,text,boolean,text) from service_role;
revoke execute on function public.requeue_source_page_partition_job_v3(uuid) from service_role;

commit;
begin;

create or replace function public.materialize_source_region_from_inventory_v6(p_inventory_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_current_freeze uuid;
  v_current_hash text;
  v_current_blocks integer;
  v_current_articles integer;
  v_current_article_fp text;
  v_mapping_count integer;
  v_mapper_model text;
  v_critic_model text;
  v_partition_job_id uuid;
  v_region_count integer;
  v_expected_passes integer;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_inventory_job_id;
  if not found then raise exception 'source_region_materialization_v6_inventory_job_missing'; end if;
  if j.status<>'completed' then raise exception 'source_region_materialization_v6_inventory_not_completed'; end if;

  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_current_freeze is null or v_current_freeze is distinct from j.freeze_receipt_id then raise exception 'source_region_materialization_v6_freeze_stale'; end if;

  select max(source_ocr_json_sha256),count(*)::integer into v_current_hash,v_current_blocks
  from public.source_ocr_blocks_v1 where source_image_id=j.inventory_source_image_id and page_index=0;
  select article_count,article_set_fingerprint into v_current_articles,v_current_article_fp
  from public.inventory_page_article_set_proof_v1(j.page_identity_source_image_id);
  if v_current_hash is distinct from j.source_ocr_json_sha256 or v_current_blocks<>j.block_count or v_current_articles<>j.existing_article_count or v_current_article_fp<>j.page_article_set_fingerprint then
    raise exception 'source_region_materialization_v6_input_stale';
  end if;

  v_expected_passes:=case when j.requires_third_pass then 3 else 2 end;
  if (select count(*) from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id)<>v_expected_passes then
    raise exception 'source_region_materialization_v6_blind_receipts_incomplete';
  end if;
  select max(model) filter(where pass_kind='mapper'),max(model) filter(where pass_kind='critic')
    into v_mapper_model,v_critic_model
  from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id;
  if coalesce(v_mapper_model,'')='' or coalesce(v_critic_model,'')='' or v_mapper_model=v_critic_model then
    raise exception 'source_region_materialization_v6_blind_receipts_invalid';
  end if;

  select count(*)::integer into v_mapping_count from public.source_page_article_inventory_mappings_v2 where job_id=j.id;
  if v_mapping_count<>j.existing_article_count
     or (select count(distinct article_id) from public.source_page_article_inventory_mappings_v2 where job_id=j.id)<>j.existing_article_count
     or (select count(*) from public.source_page_article_inventory_consensus_groups_v2 where job_id=j.id)<>j.existing_article_count then
    raise exception 'source_region_materialization_v6_mapping_not_bijective';
  end if;

  if exists(
    select 1
    from public.source_page_article_inventory_mappings_v2 mp
    join public.source_page_article_inventory_consensus_groups_v2 g on g.job_id=mp.job_id and g.group_fingerprint=mp.group_fingerprint
    join public.formal_corpus_articles_v1 a on a.id=mp.article_id
    where mp.job_id=j.id
      and similarity(public.normalize_article_headline_v1(a.headline),public.normalize_article_headline_v1(g.headline_anchor))<0.20
      and not (
        exists(select 1 from public.source_page_article_inventory_mapping_stage_v2 s where s.job_id=j.id and s.pass_kind='mapper' and s.group_fingerprint=mp.group_fingerprint and s.article_id=mp.article_id and s.confidence>=0.80)
        and exists(select 1 from public.source_page_article_inventory_mapping_stage_v2 s where s.job_id=j.id and s.pass_kind='critic' and s.group_fingerprint=mp.group_fingerprint and s.article_id=mp.article_id and s.confidence>=0.80)
        and (select count(*) from public.source_page_article_inventory_mapping_pass_runs_v2 pr where pr.job_id=j.id)=2
      )
  ) then raise exception 'source_region_materialization_v6_weak_mapping_requires_dual_review'; end if;

  if exists(
    (select mp.article_id from public.source_page_article_inventory_mappings_v2 mp where mp.job_id=j.id
     except
     select a.id from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id)
    union all
    (select a.id from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id where cm.page_identity_source_image_id=j.page_identity_source_image_id
     except
     select mp.article_id from public.source_page_article_inventory_mappings_v2 mp where mp.job_id=j.id)
  ) then raise exception 'source_region_materialization_v6_article_set_mismatch'; end if;

  insert into public.source_page_partition_jobs_v3(
    page_identity_source_image_id,evidence_source_image_id,page_index,partition_version,freeze_receipt_id,
    source_ocr_json_sha256,page_article_set_fingerprint,article_count,block_count,status,
    mapper_model,critic_model,disagreement_count,attempt_count,started_at,finished_at,updated_at
  ) values(
    j.page_identity_source_image_id,j.inventory_source_image_id,0,'source_region_v6_inventory_consensus',j.freeze_receipt_id,
    j.source_ocr_json_sha256,j.page_article_set_fingerprint,j.existing_article_count,j.block_count,'completed',
    v_mapper_model,v_critic_model,0,0,now(),now(),now()
  )
  on conflict(evidence_source_image_id,page_index,partition_version,freeze_receipt_id,source_ocr_json_sha256,page_article_set_fingerprint)
  do update set page_identity_source_image_id=excluded.page_identity_source_image_id,article_count=excluded.article_count,block_count=excluded.block_count,
                status='completed',mapper_model=excluded.mapper_model,critic_model=excluded.critic_model,disagreement_count=0,
                attempt_count=0,last_error_class=null,error_message=null,next_retry_at=null,lease_token=null,lease_expires_at=null,finished_at=now(),updated_at=now()
  returning id into v_partition_job_id;

  delete from public.source_ocr_block_assignments_v2
  where source_image_id=j.inventory_source_image_id and page_index=0 and assignment_version='source_block_partition_v6_inventory_consensus';

  insert into public.source_ocr_block_assignments_v2(
    source_image_id,page_index,block_index,assignment_version,assignment_kind,article_id,non_article_role,
    assignment_confidence,assignment_reason,source_ocr_json_sha256,updated_at
  )
  select j.inventory_source_image_id,0,bi,'source_block_partition_v6_inventory_consensus','article',mp.article_id,null,
         q.min_confidence,
         'blind inventory consensus; mapping='||mp.mapping_method||'; group='||g.group_fingerprint,
         j.source_ocr_json_sha256,now()
  from public.source_page_article_inventory_consensus_groups_v2 g
  join public.source_page_article_inventory_mappings_v2 mp on mp.job_id=g.job_id and mp.group_fingerprint=g.group_fingerprint
  cross join lateral unnest(g.block_indices) bi
  join lateral (
    select min(ig.confidence)::numeric min_confidence
    from public.source_page_article_inventory_groups_v1 ig
    where ig.job_id=j.id and ig.group_fingerprint=g.group_fingerprint and ig.group_kind='article'
      and ig.pass_kind in ('mapper','critic','adjudicator')
  ) q on true
  where g.job_id=j.id;

  insert into public.source_ocr_block_assignments_v2(
    source_image_id,page_index,block_index,assignment_version,assignment_kind,article_id,non_article_role,
    assignment_confidence,assignment_reason,source_ocr_json_sha256,updated_at
  )
  select b.source_image_id,b.page_index,b.block_index,'source_block_partition_v6_inventory_consensus','non_article',null,'inventory_consensus_non_article',
         coalesce((select min(ig.confidence)::numeric from public.source_page_article_inventory_groups_v1 ig where ig.job_id=j.id and b.block_index=any(ig.block_indices)),0.80),
         'not assigned to any independently agreed editorial article group',j.source_ocr_json_sha256,now()
  from public.source_ocr_blocks_v1 b
  where b.source_image_id=j.inventory_source_image_id and b.page_index=0
    and not exists(select 1 from public.source_ocr_block_assignments_v2 a where a.source_image_id=b.source_image_id and a.page_index=b.page_index and a.block_index=b.block_index and a.assignment_version='source_block_partition_v6_inventory_consensus');

  if (select count(*) from public.source_ocr_block_assignments_v2 a where a.source_image_id=j.inventory_source_image_id and a.page_index=0 and a.assignment_version='source_block_partition_v6_inventory_consensus')<>j.block_count then
    raise exception 'source_region_materialization_v6_block_partition_incomplete';
  end if;

  insert into public.article_source_regions(
    article_id,source_image_id,region_version,page_index,x_min,y_min,x_max,y_max,mapping_method,mapping_confidence,
    headline_anchor,headline_similarity,source_region_text,source_region_sha256,source_image_raw_ocr_sha256,source_clean_body_sha256,
    quality_status,quality_reason,model,block_partition_version,assigned_block_count,partition_fingerprint,partition_job_id,updated_at
  )
  select mp.article_id,j.inventory_source_image_id,'source_region_v6_inventory_consensus',0,
         min(b.x_min),min(b.y_min),max(b.x_max),max(b.y_max),
         'blind_inventory_v2+'||mp.mapping_method,min(a.assignment_confidence),g.headline_anchor,
         max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))),
         string_agg(b.block_text,E'\n\n' order by b.block_index),
         encode(extensions.digest(convert_to(string_agg(b.block_text,E'\n\n' order by b.block_index),'UTF8'),'sha256'),'hex'),
         s.raw_ocr_sha256,at.analysis_body_clean_sha256,'passed',
         'deterministic region materialized from independently agreed blind inventory and bijective article mapping',
         'inventory_mapper='||v_mapper_model||';inventory_critic='||v_critic_model,
         'source_block_partition_v6_inventory_consensus',count(*)::integer,
         encode(extensions.digest(convert_to(string_agg(a.page_index::text||':'||a.block_index::text||':'||a.source_ocr_json_sha256,'|' order by a.page_index,a.block_index),'UTF8'),'sha256'),'hex'),
         v_partition_job_id,now()
  from public.source_page_article_inventory_mappings_v2 mp
  join public.source_page_article_inventory_consensus_groups_v2 g on g.job_id=mp.job_id and g.group_fingerprint=mp.group_fingerprint
  join public.formal_corpus_articles_v1 f on f.id=mp.article_id
  join public.articles at on at.id=f.id
  join public.source_ocr_block_assignments_v2 a on a.article_id=mp.article_id and a.source_image_id=j.inventory_source_image_id and a.page_index=0 and a.assignment_version='source_block_partition_v6_inventory_consensus' and a.assignment_kind='article'
  join public.source_ocr_blocks_v1 b on b.source_image_id=a.source_image_id and b.page_index=a.page_index and b.block_index=a.block_index
  join public.source_images s on s.id=j.inventory_source_image_id
  where mp.job_id=j.id
  group by mp.article_id,mp.mapping_method,g.headline_anchor,f.headline,s.raw_ocr_sha256,at.analysis_body_clean_sha256
  on conflict(article_id,region_version) do update set
    source_image_id=excluded.source_image_id,page_index=excluded.page_index,x_min=excluded.x_min,y_min=excluded.y_min,x_max=excluded.x_max,y_max=excluded.y_max,
    mapping_method=excluded.mapping_method,mapping_confidence=excluded.mapping_confidence,headline_anchor=excluded.headline_anchor,headline_similarity=excluded.headline_similarity,
    source_region_text=excluded.source_region_text,source_region_sha256=excluded.source_region_sha256,source_image_raw_ocr_sha256=excluded.source_image_raw_ocr_sha256,
    source_clean_body_sha256=excluded.source_clean_body_sha256,quality_status=excluded.quality_status,quality_reason=excluded.quality_reason,model=excluded.model,
    block_partition_version=excluded.block_partition_version,assigned_block_count=excluded.assigned_block_count,partition_fingerprint=excluded.partition_fingerprint,
    partition_job_id=excluded.partition_job_id,updated_at=now();

  select count(*)::integer into v_region_count from public.article_source_regions r where r.partition_job_id=v_partition_job_id and r.region_version='source_region_v6_inventory_consensus' and r.quality_status='passed';
  if v_region_count<>j.existing_article_count then raise exception 'source_region_materialization_v6_region_count_mismatch'; end if;

  return jsonb_build_object('status','completed','inventory_job_id',j.id,'partition_job_id',v_partition_job_id,'article_regions',v_region_count,'blocks',j.block_count);
end
$function$;

revoke all on function public.materialize_source_region_from_inventory_v6(uuid) from public,anon,authenticated,service_role;

create or replace function public.trg_materialize_source_region_from_inventory_v6()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    perform public.materialize_source_region_from_inventory_v6(new.id);
  end if;
  return new;
end
$function$;
revoke all on function public.trg_materialize_source_region_from_inventory_v6() from public,anon,authenticated,service_role;

drop trigger if exists trg_materialize_source_region_from_inventory_v6 on public.source_page_article_inventory_jobs_v1;
create trigger trg_materialize_source_region_from_inventory_v6
after update of status on public.source_page_article_inventory_jobs_v1
for each row execute function public.trg_materialize_source_region_from_inventory_v6();

create or replace function public.fail_source_page_article_inventory_job_v2(
  p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;v_message text:=coalesce(p_error_message,'inventory worker failed');v_structural boolean;v_failures integer;v_next text;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'inventory_v2_fail_lease_invalid'; end if;
  v_structural := v_message ~* '(groups array is missing|group is not an object|invalid group_kind|empty block_indices|unknown block index|assigned more than once|headline_anchor|non_article_role|block partition incomplete|mappings array missing|mapping row count mismatch|mapping row is not an object|invalid or duplicate group mapping|invalid or duplicate article mapping|mapping is not bijective|exhausted repair attempt|source_region_materialization_v6)';
  v_failures:=j.attempt_count+1;
  v_next:=case when v_structural then 'needs_review' when coalesce(p_retryable,true) and v_failures<4 then 'queued' else 'failed' end;
  update public.source_page_article_inventory_jobs_v1 set status=v_next,attempt_count=v_failures,lease_token=null,lease_expires_at=null,error_message=left(v_message,4000),updated_at=now(),finished_at=case when v_next='failed' then now() else null end where id=p_job_id;
  return jsonb_build_object('status',v_next,'attempt_count',v_failures,'retry_scheduled',(v_next='queued'),'structural_failure',v_structural);
end
$function$;

commit;
create or replace function public.finalize_source_page_partition_job_v3(p_job_id uuid,p_lease_token uuid,p_mapper_model text,p_critic_model text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;
  v_current_freeze uuid;
  v_current_hash text;
  v_current_articles integer;
  v_current_article_fp text;
  v_current_blocks integer;
  v_mapper_count integer;
  v_critic_count integer;
  v_low_conf integer;
  v_disagree integer;
  v_missing_article integer;
  v_weak_grounding integer;
begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id for update;
  if not found then raise exception 'partition_v3_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'partition_v3_job_lease_invalid'; end if;

  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v1 where freeze_gate='passed';
  if v_current_freeze is null or v_current_freeze is distinct from j.freeze_receipt_id then
    update public.source_page_partition_jobs_v3 set status='failed',last_error_class='stale_freeze',error_message='formal_corpus_freeze_changed',finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
    return jsonb_build_object('status','failed','reason','stale_freeze');
  end if;

  select max(source_ocr_json_sha256),count(*)::integer into v_current_hash,v_current_blocks from public.source_ocr_blocks_v1 where source_image_id=j.evidence_source_image_id and page_index=j.page_index;
  select article_count,article_set_fingerprint into v_current_articles,v_current_article_fp from public.source_page_identity_article_set_proof_v3(j.page_identity_source_image_id);
  if v_current_hash is distinct from j.source_ocr_json_sha256 or v_current_blocks<>j.block_count or v_current_articles<>j.article_count or v_current_article_fp<>j.page_article_set_fingerprint then
    update public.source_page_partition_jobs_v3 set status='failed',last_error_class='stale_input',error_message='source_page_partition_v3_input_changed',finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
    return jsonb_build_object('status','failed','reason','stale_input');
  end if;

  select count(*) filter(where pass_kind='mapper')::integer,count(*) filter(where pass_kind='critic')::integer,count(*) filter(where confidence<0.80)::integer into v_mapper_count,v_critic_count,v_low_conf from public.source_page_partition_proposals_v3 where job_id=j.id;

  select count(*)::integer into v_disagree
  from public.source_page_partition_proposals_v3 m
  join public.source_page_partition_proposals_v3 c on c.job_id=m.job_id and c.block_index=m.block_index and c.pass_kind='critic'
  where m.job_id=j.id and m.pass_kind='mapper' and (m.assignment_kind<>c.assignment_kind or m.article_id is distinct from c.article_id);

  with page_articles as (
    select f.id from public.formal_corpus_articles_v1 f join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id where m.page_identity_source_image_id=j.page_identity_source_image_id
  )
  select count(*)::integer into v_missing_article
  from page_articles f
  where not exists(select 1 from public.source_page_partition_proposals_v3 p where p.job_id=j.id and p.pass_kind='mapper' and p.assignment_kind='article' and p.article_id=f.id)
     or not exists(select 1 from public.source_page_partition_proposals_v3 p where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=f.id);

  with page_articles as (
    select f.id,f.headline,a.analysis_body_clean_sha256
    from public.formal_corpus_articles_v1 f
    join public.articles a on a.id=f.id
    join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
    where m.page_identity_source_image_id=j.page_identity_source_image_id
  ), crit as (
    select f.id,f.analysis_body_clean_sha256,max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))) headline_sim,
           string_agg(b.block_text,E'\n\n' order by p.block_index) region_text
    from page_articles f
    join public.source_page_partition_proposals_v3 p on p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=f.id
    join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index
    group by f.id,f.analysis_body_clean_sha256
  )
  select count(*)::integer into v_weak_grounding
  from crit c
  where coalesce(c.headline_sim,0)<0.20
    and not public.grounding_review_passes_v3(j.id,c.id,j.evidence_source_image_id,c.region_text,c.analysis_body_clean_sha256,(select raw_ocr_sha256 from public.source_images where id=j.evidence_source_image_id));

  if v_mapper_count<>j.block_count or v_critic_count<>j.block_count or v_low_conf>0 or v_disagree>0 or v_missing_article>0 or v_weak_grounding>0 then
    update public.source_page_partition_jobs_v3
    set status='needs_review',mapper_model=p_mapper_model,critic_model=p_critic_model,disagreement_count=v_disagree,last_error_class='partition_quality',error_message=format('mapper=%s critic=%s expected=%s low_conf=%s disagreements=%s missing_articles=%s weak_grounding=%s',v_mapper_count,v_critic_count,j.block_count,v_low_conf,v_disagree,v_missing_article,v_weak_grounding),next_retry_at=null,lease_token=null,lease_expires_at=null,updated_at=now()
    where id=j.id;
    return jsonb_build_object('status','needs_review','mapper_count',v_mapper_count,'critic_count',v_critic_count,'expected_block_count',j.block_count,'low_confidence',v_low_conf,'disagreements',v_disagree,'missing_articles',v_missing_article,'weak_grounding',v_weak_grounding);
  end if;

  delete from public.source_ocr_block_assignments_v2 where source_image_id=j.evidence_source_image_id and page_index=j.page_index and assignment_version='source_block_partition_v3_page_identity';
  insert into public.source_ocr_block_assignments_v2(source_image_id,page_index,block_index,assignment_version,assignment_kind,article_id,non_article_role,assignment_confidence,assignment_reason,source_ocr_json_sha256)
  select c.source_image_id,c.page_index,c.block_index,'source_block_partition_v3_page_identity',c.assignment_kind,c.article_id,case when c.assignment_kind='non_article' then c.non_article_role else null end,least(m.confidence,c.confidence),concat_ws(' | ','mapper: '||coalesce(m.reason,''),'critic: '||coalesce(c.reason,'')),j.source_ocr_json_sha256
  from public.source_page_partition_proposals_v3 c
  join public.source_page_partition_proposals_v3 m on m.job_id=c.job_id and m.block_index=c.block_index and m.pass_kind='mapper'
  where c.job_id=j.id and c.pass_kind='critic';

  insert into public.article_source_regions(article_id,source_image_id,region_version,page_index,x_min,y_min,x_max,y_max,mapping_method,mapping_confidence,headline_anchor,headline_similarity,source_region_text,source_region_sha256,source_image_raw_ocr_sha256,source_clean_body_sha256,quality_status,quality_reason,model,block_partition_version,assigned_block_count,partition_fingerprint,partition_job_id,updated_at)
  select f.id,j.evidence_source_image_id,'source_region_v3_page_identity_blockset',j.page_index,min(b.x_min),min(b.y_min),max(b.x_max),max(b.y_max),'dual_pass_page_identity_partition_v3',min(a.assignment_confidence),(array_agg(b.block_text order by similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text)) desc,b.block_index))[1],max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))),string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index),encode(extensions.digest(convert_to(string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index),'UTF8'),'sha256'),'hex'),s.raw_ocr_sha256,at.analysis_body_clean_sha256,'passed','dual_pass_mapper_critic_agreement_with_snapshot_bound_secondary_grounding_when_required','mapper='||coalesce(p_mapper_model,'')||';critic='||coalesce(p_critic_model,''),'source_block_partition_v3_page_identity',count(*)::integer,encode(extensions.digest(convert_to(string_agg(a.page_index::text||':'||a.block_index::text||':'||a.source_ocr_json_sha256,'|' order by a.page_index,a.block_index),'UTF8'),'sha256'),'hex'),j.id,now()
  from public.formal_corpus_articles_v1 f
  join public.articles at on at.id=f.id
  join public.source_page_capture_map_v1 pm on pm.source_image_id=f.source_image_id and pm.page_identity_source_image_id=j.page_identity_source_image_id
  join public.source_ocr_block_assignments_v2 a on a.article_id=f.id and a.source_image_id=j.evidence_source_image_id and a.page_index=j.page_index and a.assignment_version='source_block_partition_v3_page_identity' and a.assignment_kind='article'
  join public.source_ocr_blocks_v1 b using(source_image_id,page_index,block_index)
  join public.source_images s on s.id=j.evidence_source_image_id
  group by f.id,s.raw_ocr_sha256,at.analysis_body_clean_sha256
  on conflict(article_id,region_version) do update set source_image_id=excluded.source_image_id,page_index=excluded.page_index,x_min=excluded.x_min,y_min=excluded.y_min,x_max=excluded.x_max,y_max=excluded.y_max,mapping_method=excluded.mapping_method,mapping_confidence=excluded.mapping_confidence,headline_anchor=excluded.headline_anchor,headline_similarity=excluded.headline_similarity,source_region_text=excluded.source_region_text,source_region_sha256=excluded.source_region_sha256,source_image_raw_ocr_sha256=excluded.source_image_raw_ocr_sha256,source_clean_body_sha256=excluded.source_clean_body_sha256,quality_status=excluded.quality_status,quality_reason=excluded.quality_reason,model=excluded.model,block_partition_version=excluded.block_partition_version,assigned_block_count=excluded.assigned_block_count,partition_fingerprint=excluded.partition_fingerprint,partition_job_id=excluded.partition_job_id,updated_at=now();

  update public.source_page_partition_jobs_v3 set status='completed',mapper_model=p_mapper_model,critic_model=p_critic_model,disagreement_count=0,error_message=null,last_error_class=null,next_retry_at=null,finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','block_count',j.block_count,'article_count',j.article_count,'page_identity',j.page_identity_source_image_id,'evidence_capture',j.evidence_source_image_id);
end $$;
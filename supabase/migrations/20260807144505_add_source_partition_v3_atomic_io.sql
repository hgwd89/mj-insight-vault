create function public.get_source_page_partition_job_input_v3(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;
  v_current_freeze uuid;
  v_current_hash text;
  v_current_blocks integer;
  v_current_articles integer;
  v_current_article_fp text;
  v_blocks jsonb;
  v_articles jsonb;
begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id;
  if not found then raise exception 'partition_v3_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'partition_v3_job_lease_invalid'; end if;

  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v1 where freeze_gate='passed';
  if v_current_freeze is null or v_current_freeze<>j.freeze_receipt_id then raise exception 'partition_v3_freeze_stale'; end if;

  select max(source_ocr_json_sha256),count(*)::integer into v_current_hash,v_current_blocks
  from public.source_ocr_blocks_v1 where source_image_id=j.evidence_source_image_id and page_index=j.page_index;
  select article_count,article_set_fingerprint into v_current_articles,v_current_article_fp
  from public.source_page_identity_article_set_proof_v3(j.page_identity_source_image_id);
  if v_current_hash is distinct from j.source_ocr_json_sha256 or v_current_blocks<>j.block_count or v_current_articles<>j.article_count or v_current_article_fp<>j.page_article_set_fingerprint then raise exception 'partition_v3_input_stale'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'block_index',b.block_index,
    'text',b.block_text,
    'x_min',b.x_min,'y_min',b.y_min,'x_max',b.x_max,'y_max',b.y_max,
    'ocr_confidence',b.ocr_confidence
  ) order by b.block_index),'[]'::jsonb) into v_blocks
  from public.source_ocr_blocks_v1 b
  where b.source_image_id=j.evidence_source_image_id and b.page_index=j.page_index;

  select coalesce(jsonb_agg(jsonb_build_object(
    'article_id',f.id,
    'source_capture_image_id',f.source_image_id,
    'headline',f.headline,
    'article_date',a.article_date_normalized,
    'analysis_body_clean',a.analysis_body_clean,
    'analysis_body_clean_sha256',a.analysis_body_clean_sha256,
    'headline_seed',coalesce((select max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))) from public.source_ocr_blocks_v1 b where b.source_image_id=j.evidence_source_image_id and b.page_index=j.page_index),0),
    'requires_secondary_grounding',coalesce((select max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))) from public.source_ocr_blocks_v1 b where b.source_image_id=j.evidence_source_image_id and b.page_index=j.page_index),0)<0.20
  ) order by coalesce(a.article_date_normalized::text,''),f.id::text),'[]'::jsonb) into v_articles
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
  where m.page_identity_source_image_id=j.page_identity_source_image_id;

  return jsonb_build_object(
    'job',jsonb_build_object(
      'id',j.id,'page_identity_source_image_id',j.page_identity_source_image_id,'evidence_source_image_id',j.evidence_source_image_id,'page_index',j.page_index,
      'freeze_receipt_id',j.freeze_receipt_id,'source_ocr_json_sha256',j.source_ocr_json_sha256,'page_article_set_fingerprint',j.page_article_set_fingerprint,
      'article_count',j.article_count,'block_count',j.block_count,'attempt_count',j.attempt_count,'lease_token',j.lease_token,'lease_expires_at',j.lease_expires_at
    ),
    'articles',v_articles,
    'blocks',v_blocks,
    'source',(
      select jsonb_build_object('file_name',s.file_name,'publication_date',s.publication_date,'raw_ocr_sha256',s.raw_ocr_sha256,'ocr_text_raw',s.ocr_text_raw)
      from public.source_images s where s.id=j.evidence_source_image_id
    )
  );
end $$;

create function public.replace_source_page_partition_proposals_v3(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;
  v_count integer;
  v_distinct integer;
begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id for update;
  if not found then raise exception 'partition_v3_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'partition_v3_job_lease_invalid'; end if;
  if p_pass_kind not in ('mapper','critic') then raise exception 'partition_v3_invalid_pass_kind'; end if;
  if jsonb_typeof(p_rows)<>'array' then raise exception 'partition_v3_rows_must_be_array'; end if;

  select count(*),count(distinct block_index) into v_count,v_distinct
  from jsonb_to_recordset(p_rows) as x(block_index integer,assignment_kind text,article_id uuid,non_article_role text,confidence numeric,reason text);
  if v_count<>j.block_count or v_distinct<>j.block_count then raise exception 'partition_v3_proposal_count_mismatch expected % got % distinct %',j.block_count,v_count,v_distinct; end if;

  delete from public.article_source_grounding_reviews_v3 where partition_job_id=j.id;
  delete from public.source_page_partition_proposals_v3 where job_id=j.id and pass_kind=p_pass_kind;

  insert into public.source_page_partition_proposals_v3(job_id,pass_kind,source_image_id,page_index,block_index,assignment_kind,article_id,non_article_role,confidence,reason)
  select j.id,p_pass_kind,j.evidence_source_image_id,j.page_index,x.block_index,x.assignment_kind,x.article_id,
         case when x.assignment_kind='non_article' then coalesce(nullif(btrim(x.non_article_role),''),'other_non_article') else null end,
         greatest(0,least(1,coalesce(x.confidence,0))),left(coalesce(x.reason,''),800)
  from jsonb_to_recordset(p_rows) as x(block_index integer,assignment_kind text,article_id uuid,non_article_role text,confidence numeric,reason text);

  return jsonb_build_object('status','stored','job_id',j.id,'pass_kind',p_pass_kind,'row_count',v_count);
end $$;
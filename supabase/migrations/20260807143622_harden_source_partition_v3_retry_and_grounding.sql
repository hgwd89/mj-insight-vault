update public.source_page_primary_capture_v1
set selection_status = case when headline_ge020_count=article_count then 'selected' else 'needs_secondary_grounding' end,
    selected_at=now();

create or replace function public.validate_article_source_grounding_review_v3()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare
  v_article_source uuid;
  v_article_page uuid;
  v_evidence_page uuid;
  v_article_text text;
  v_source_text text;
  v_term text;
  v_terms text[];
  v_total_chars integer:=0;
begin
  select f.source_image_id, coalesce(f.headline,'')||' '||coalesce(a.analysis_body_clean,'')
    into v_article_source,v_article_text
  from public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id
  where f.id=new.article_id;
  if v_article_source is null then raise exception 'grounding_review_article_not_current_formal'; end if;

  select page_identity_source_image_id into v_article_page from public.source_page_capture_map_v1 where source_image_id=v_article_source;
  select page_identity_source_image_id into v_evidence_page from public.source_page_capture_map_v1 where source_image_id=new.evidence_source_image_id;
  if v_article_page is null or v_evidence_page is null or v_article_page<>v_evidence_page then raise exception 'grounding_review_capture_not_same_page_identity'; end if;

  select coalesce(ocr_text_raw,'') into v_source_text from public.source_images where id=new.evidence_source_image_id;
  if v_source_text='' then raise exception 'grounding_review_source_ocr_missing'; end if;

  select coalesce(array_agg(t order by t),'{}'::text[]) into v_terms
  from (
    select distinct btrim(x) t
    from unnest(coalesce(new.shared_terms,'{}'::text[])) x
    where btrim(x)<>''
  ) q;
  if coalesce(array_length(v_terms,1),0)<3 then raise exception 'grounding_review_requires_three_distinct_shared_terms'; end if;

  foreach v_term in array v_terms loop
    if char_length(v_term)<3 then raise exception 'grounding_review_term_too_short'; end if;
    if position(v_term in v_article_text)=0 then raise exception 'grounding_review_term_missing_from_article'; end if;
    if position(v_term in v_source_text)=0 then raise exception 'grounding_review_term_missing_from_source_ocr'; end if;
    v_total_chars:=v_total_chars+char_length(v_term);
  end loop;
  if v_total_chars<12 then raise exception 'grounding_review_shared_terms_not_sufficient'; end if;
  new.shared_terms:=v_terms;
  return new;
end $$;

create or replace function public.claim_source_page_partition_job_v3(p_lease_seconds integer default 240)
returns setof public.source_page_partition_jobs_v3 language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid; v_token uuid:=gen_random_uuid();begin
  select id into v_id from public.source_page_partition_jobs_v3
  where (
      status='queued'
      or (status='running' and (lease_expires_at is null or lease_expires_at<now()))
    )
    and attempt_count<4
    and (next_retry_at is null or next_retry_at<=now())
  order by created_at
  for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.source_page_partition_jobs_v3
  set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(60,p_lease_seconds)),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null
  where id=v_id;
  return query select * from public.source_page_partition_jobs_v3 where id=v_id;
end $$;

create function public.fail_source_page_partition_job_v3(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.source_page_partition_jobs_v3%rowtype; v_retry boolean; v_delay integer;begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id for update;
  if not found then raise exception 'partition_v3_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'partition_v3_job_lease_invalid'; end if;
  v_retry:=coalesce(p_retryable,true) and j.attempt_count<4;
  v_delay:=least(600,30*(2^greatest(0,j.attempt_count-1))::integer);
  update public.source_page_partition_jobs_v3
  set status=case when v_retry then 'queued' else 'failed' end,
      last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),
      error_message=left(coalesce(p_error_message,'partition worker failed'),2000),
      next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,
      finished_at=case when v_retry then null else now() end,
      lease_token=null,lease_expires_at=null,updated_at=now()
  where id=j.id;
  return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',j.attempt_count,'retry_after_seconds',case when v_retry then v_delay else null end);
end $$;

create function public.requeue_source_page_partition_job_v3(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.source_page_partition_jobs_v3%rowtype;begin
  select * into j from public.source_page_partition_jobs_v3 where id=p_job_id for update;
  if not found then raise exception 'partition_v3_job_missing'; end if;
  if j.status not in ('needs_review','failed') then raise exception 'partition_v3_job_not_reviewable'; end if;
  update public.source_page_partition_jobs_v3 set status='queued',attempt_count=0,next_retry_at=null,last_error_class=null,error_message=null,finished_at=null,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','job_id',j.id);
end $$;
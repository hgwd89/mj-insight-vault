alter table public.article_source_grounding_reviews_v3
  add column partition_job_id uuid references public.source_page_partition_jobs_v3(id),
  add column freeze_receipt_id uuid references public.formal_corpus_freeze_receipts_v1(id),
  add column article_clean_body_sha256 text,
  add column source_ocr_sha256 text,
  add column region_sha256 text,
  add column grounding_model text,
  add column grounding_decision text;

alter table public.article_source_grounding_reviews_v3
  drop constraint article_source_grounding_reviews_v3_pkey,
  add constraint article_source_grounding_reviews_v3_hash_article_check check(article_clean_body_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint article_source_grounding_reviews_v3_hash_source_check check(source_ocr_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint article_source_grounding_reviews_v3_hash_region_check check(region_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint article_source_grounding_reviews_v3_grounding_decision_check check(grounding_decision in ('passed','failed'));

alter table public.article_source_grounding_reviews_v3
  alter column partition_job_id set not null,
  alter column freeze_receipt_id set not null,
  alter column article_clean_body_sha256 set not null,
  alter column source_ocr_sha256 set not null,
  alter column region_sha256 set not null,
  alter column grounding_decision set not null,
  add primary key(partition_job_id,article_id,review_version);

create or replace function public.validate_article_source_grounding_review_v3()
returns trigger language plpgsql set search_path=pg_catalog,public,extensions as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;
  v_article_source uuid;
  v_article_page uuid;
  v_article_text text;
  v_article_hash text;
  v_source_page uuid;
  v_source_text text;
  v_source_hash text;
  v_current_freeze uuid;
  v_region_text text;
  v_region_hash text;
  v_term text;
  v_terms text[];
  v_total_chars integer:=0;
  v_unique_region_terms integer:=0;
  v_other_region_hits integer;
begin
  select * into j from public.source_page_partition_jobs_v3 where id=new.partition_job_id;
  if not found then raise exception 'grounding_review_partition_job_missing'; end if;
  if j.status not in ('running','needs_review') then raise exception 'grounding_review_partition_job_not_writable'; end if;
  if new.evidence_source_image_id<>j.evidence_source_image_id then raise exception 'grounding_review_evidence_capture_mismatch'; end if;
  if new.freeze_receipt_id<>j.freeze_receipt_id then raise exception 'grounding_review_freeze_receipt_mismatch'; end if;

  select freeze_receipt_id into v_current_freeze from public.formal_corpus_freeze_gate_v1 where freeze_gate='passed';
  if v_current_freeze is null or v_current_freeze<>j.freeze_receipt_id then raise exception 'grounding_review_current_freeze_stale'; end if;

  select f.source_image_id,coalesce(f.headline,'')||' '||coalesce(a.analysis_body_clean,''),a.analysis_body_clean_sha256
    into v_article_source,v_article_text,v_article_hash
  from public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id
  where f.id=new.article_id;
  if v_article_source is null then raise exception 'grounding_review_article_not_current_formal'; end if;
  if new.article_clean_body_sha256<>v_article_hash then raise exception 'grounding_review_article_hash_mismatch'; end if;

  select page_identity_source_image_id into v_article_page from public.source_page_capture_map_v1 where source_image_id=v_article_source;
  select page_identity_source_image_id into v_source_page from public.source_page_capture_map_v1 where source_image_id=new.evidence_source_image_id;
  if v_article_page is null or v_source_page is null or v_article_page<>v_source_page or v_article_page<>j.page_identity_source_image_id then raise exception 'grounding_review_capture_not_same_page_identity'; end if;

  select coalesce(ocr_text_raw,''),raw_ocr_sha256 into v_source_text,v_source_hash from public.source_images where id=new.evidence_source_image_id;
  if v_source_text='' or v_source_hash is null then raise exception 'grounding_review_source_ocr_missing'; end if;
  if new.source_ocr_sha256<>v_source_hash then raise exception 'grounding_review_source_hash_mismatch'; end if;

  select coalesce(string_agg(b.block_text,E'\n\n' order by p.block_index),'') into v_region_text
  from public.source_page_partition_proposals_v3 p
  join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index
  where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=new.article_id;
  if v_region_text='' then raise exception 'grounding_review_critic_region_missing'; end if;
  v_region_hash:=encode(extensions.digest(convert_to(v_region_text,'UTF8'),'sha256'),'hex');
  if new.region_sha256<>v_region_hash then raise exception 'grounding_review_region_hash_mismatch'; end if;

  if new.grounding_decision='passed' then
    if new.mapper_decision<>'passed' or new.critic_decision<>'passed' then raise exception 'grounding_review_assignment_decisions_not_passed'; end if;
    select coalesce(array_agg(t order by t),'{}'::text[]) into v_terms
    from (select distinct btrim(x) t from unnest(coalesce(new.shared_terms,'{}'::text[])) x where btrim(x)<>'') q;
    if coalesce(array_length(v_terms,1),0)<3 then raise exception 'grounding_review_requires_three_distinct_shared_terms'; end if;

    foreach v_term in array v_terms loop
      if char_length(v_term)<3 then raise exception 'grounding_review_term_too_short'; end if;
      if position(v_term in v_article_text)=0 then raise exception 'grounding_review_term_missing_from_article'; end if;
      if position(v_term in v_source_text)=0 then raise exception 'grounding_review_term_missing_from_source_ocr'; end if;
      if position(v_term in v_region_text)=0 then raise exception 'grounding_review_term_missing_from_assigned_region'; end if;
      v_total_chars:=v_total_chars+char_length(v_term);

      select count(*) into v_other_region_hits
      from (
        select p.article_id,string_agg(b.block_text,E'\n\n' order by p.block_index) other_region
        from public.source_page_partition_proposals_v3 p
        join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index
        where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id is distinct from new.article_id
        group by p.article_id
      ) q
      where position(v_term in q.other_region)>0;
      if v_other_region_hits=0 then v_unique_region_terms:=v_unique_region_terms+1; end if;
    end loop;
    if v_total_chars<12 then raise exception 'grounding_review_shared_terms_not_sufficient'; end if;
    if v_unique_region_terms<2 then raise exception 'grounding_review_requires_two_region_specific_terms'; end if;
    new.shared_terms:=v_terms;
  else
    new.shared_terms:=coalesce(new.shared_terms,'{}'::text[]);
  end if;
  return new;
end $$;
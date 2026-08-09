alter table public.full_corpus_article_reviews_v4
  add column observed_fact_anchor text,
  add column observed_fact_block_index integer,
  add column observed_fact_block_sha256 text;

alter table public.full_corpus_theme_seeds_v4
  add column source_block_index integer,
  add column source_block_sha256 text;

alter table public.theme_census_relations_v4
  add column source_block_index integer,
  add column source_block_sha256 text;

create function public.unique_source_block_for_anchor_v4(p_article_id uuid,p_source_region_id uuid,p_anchor text)
returns table(block_index integer,source_block_sha256 text)
language sql stable security definer set search_path=pg_catalog,public as $$
select b.block_index,b.source_block_sha256
from public.formal_source_grounded_article_blocks_v4 b
where b.article_id=p_article_id and b.source_region_id=p_source_region_id
  and public.normalized_occurrence_count_v4(b.block_text,p_anchor)=1
  and not exists(
    select 1 from public.formal_source_grounded_article_blocks_v4 b2
    where b2.article_id=p_article_id and b2.source_region_id=p_source_region_id and b2.block_index<>b.block_index
      and public.normalized_occurrence_count_v4(b2.block_text,p_anchor)>0
  );
$$;

create or replace function public.validate_article_review_v4_row()
returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_batch record;v_region public.formal_source_grounded_articles_v4%rowtype;v_relevance text;v_block record;
begin
  select id,run_id,batch_index,article_ids into v_batch from public.full_corpus_scan_batches where id=new.batch_id;
  if not found or v_batch.run_id<>new.run_id or v_batch.batch_index<>new.batch_index or not(new.article_id=any(v_batch.article_ids)) then raise exception using errcode='23514',message='article_review_batch_membership_invalid'; end if;
  select * into v_region from public.formal_source_grounded_articles_v4 where source_region_id=new.source_region_id and article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='article_review_source_region_not_current_v4'; end if;
  if new.source_clean_body_sha256<>v_region.analysis_body_sha256 or new.source_region_sha256<>v_region.source_region_sha256 or new.source_image_raw_ocr_sha256<>v_region.current_source_raw_ocr_sha256 then raise exception using errcode='23514',message='article_review_source_hash_mismatch_v4'; end if;
  if coalesce(btrim(new.observed_fact),'')='' then raise exception using errcode='23514',message='article_review_observed_fact_required'; end if;
  if coalesce(btrim(new.observed_fact_anchor),'')='' then raise exception using errcode='23514',message='article_review_observed_fact_anchor_required'; end if;
  select * into v_block from public.unique_source_block_for_anchor_v4(new.article_id,new.source_region_id,new.observed_fact_anchor);
  if not found then raise exception using errcode='23514',message='article_review_observed_fact_anchor_not_unique_block'; end if;
  new.observed_fact_block_index:=v_block.block_index;new.observed_fact_block_sha256:=v_block.source_block_sha256;
  v_relevance:=public.consumer_relevance_v4(new.subject,new.measurement);new.consumer_relevance:=v_relevance;
  return new;
end $$;

create or replace function public.validate_theme_seed_v4_row()
returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_review public.full_corpus_article_reviews_v4%rowtype;v_region public.formal_source_grounded_articles_v4%rowtype;v_block record;
begin
  select * into v_review from public.full_corpus_article_reviews_v4 where id=new.review_id;
  if not found or v_review.run_id<>new.run_id or v_review.article_id<>new.article_id then raise exception using errcode='23514',message='theme_seed_review_membership_invalid'; end if;
  select * into v_region from public.formal_source_grounded_articles_v4 where article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='theme_seed_source_region_not_current_v4'; end if;
  if new.source_clean_body_sha256<>v_review.source_clean_body_sha256 or new.source_region_sha256<>v_review.source_region_sha256 then raise exception using errcode='23514',message='theme_seed_source_hash_mismatch'; end if;
  select * into v_block from public.unique_source_block_for_anchor_v4(new.article_id,v_region.source_region_id,new.source_anchor);
  if not found then raise exception using errcode='23514',message='theme_seed_source_anchor_not_unique_in_source_block'; end if;
  new.source_block_index:=v_block.block_index;new.source_block_sha256:=v_block.source_block_sha256;
  return new;
end $$;

create or replace function public.validate_census_relation_v4_row()
returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_batch public.theme_census_batches_v4%rowtype;v_region public.formal_source_grounded_articles_v4%rowtype;v_block record;
begin
  select * into v_batch from public.theme_census_batches_v4 where id=new.census_batch_id;
  if not found or v_batch.analysis_run_id<>new.analysis_run_id or not(new.article_id=any(v_batch.article_ids)) then raise exception using errcode='23514',message='census_relation_batch_membership_invalid'; end if;
  select * into v_region from public.formal_source_grounded_articles_v4 where article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='census_relation_source_not_current_v4'; end if;
  if new.source_clean_body_sha256<>v_region.analysis_body_sha256 or new.source_region_sha256<>v_region.source_region_sha256 then raise exception using errcode='23514',message='census_relation_source_hash_mismatch'; end if;
  if new.relation='none' then
    if coalesce(btrim(new.clean_body_anchor),'')<>'' or coalesce(btrim(new.source_region_anchor),'')<>'' or new.source_block_index is not null or new.source_block_sha256 is not null then raise exception using errcode='23514',message='census_none_relation_must_not_have_anchors'; end if;
  else
    if coalesce(btrim(new.clean_body_anchor),'')<>'' then raise exception using errcode='23514',message='census_clean_body_anchor_forbidden_in_source_grounded_v4'; end if;
    select * into v_block from public.unique_source_block_for_anchor_v4(new.article_id,v_region.source_region_id,new.source_region_anchor);
    if not found then raise exception using errcode='23514',message='census_source_anchor_not_unique_in_source_block'; end if;
    new.source_block_index:=v_block.block_index;new.source_block_sha256:=v_block.source_block_sha256;
  end if;
  return new;
end $$;

revoke execute on function public.unique_source_block_for_anchor_v4(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.unique_source_block_for_anchor_v4(uuid,uuid,text) to service_role;
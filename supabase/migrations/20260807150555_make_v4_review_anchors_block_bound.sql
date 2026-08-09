alter table public.full_corpus_article_review_anchors_v4
  add column source_block_index integer,
  add column source_block_sha256 text;

alter table public.full_corpus_article_review_anchors_v4
  drop constraint full_corpus_article_review_anchors_v4_anchor_slot_check,
  drop constraint full_corpus_article_review_anchors_v4_source_kind_check,
  add constraint full_corpus_article_review_anchors_v4_anchor_slot_check check(anchor_slot=any(array['primary'::text,'secondary'::text,'tertiary'::text])),
  add constraint full_corpus_article_review_anchors_v4_source_kind_check check(source_kind='source_region'::text),
  add constraint full_corpus_article_review_anchors_v4_source_block_required check(source_block_index is not null),
  add constraint full_corpus_article_review_anchors_v4_source_block_sha_check check(source_block_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint full_corpus_article_review_anchors_v4_review_block_unique unique(review_id,source_block_index);

create function public.normalized_occurrence_count_v4(p_haystack text,p_needle text)
returns integer
language sql immutable
set search_path=pg_catalog
as $$
with x as (
  select lower(regexp_replace(coalesce(p_haystack,''),'\s+',' ','g')) h,
         lower(regexp_replace(btrim(coalesce(p_needle,'')),'\s+',' ','g')) n
)
select case when n='' then 0 else ((length(h)-length(replace(h,n,'')))/greatest(1,length(n)))::integer end from x;
$$;

create view public.formal_source_grounded_article_blocks_v4 as
select g.article_id,g.source_region_id,g.partition_job_id,g.page_identity_source_image_id,g.evidence_source_image_id,
       a.block_index,b.block_text,b.x_min,b.y_min,b.x_max,b.y_max,b.ocr_confidence,
       encode(extensions.digest(convert_to(b.block_text,'UTF8'),'sha256'),'hex') source_block_sha256
from public.formal_source_grounded_articles_v4 g
join public.source_ocr_block_assignments_v2 a
  on a.article_id=g.article_id and a.source_image_id=g.evidence_source_image_id and a.assignment_version='source_block_partition_v3_page_identity' and a.assignment_kind='article'
join public.source_ocr_blocks_v1 b
  on b.source_image_id=a.source_image_id and b.page_index=a.page_index and b.block_index=a.block_index;

create view public.source_region_coverage_targets_v4 as
with ranked as (
  select b.*,
         row_number() over(partition by b.article_id,b.source_region_id order by b.x_min,b.y_min,b.block_index) rn,
         count(*) over(partition by b.article_id,b.source_region_id) n
  from public.formal_source_grounded_article_blocks_v4 b
), target_rows as (
  select r.*,'primary'::text anchor_slot from ranked r where r.rn=1
  union all
  select r.*,'secondary'::text anchor_slot from ranked r
   where (r.n=2 and r.rn=2) or (r.n>=3 and r.rn=ceil(r.n::numeric/2.0)::integer)
  union all
  select r.*,'tertiary'::text anchor_slot from ranked r where r.n>=3 and r.rn=r.n
)
select article_id,source_region_id,partition_job_id,page_identity_source_image_id,evidence_source_image_id,
       anchor_slot,block_index,block_text,source_block_sha256,x_min,y_min,x_max,y_max,ocr_confidence,n as region_block_count
from target_rows;

create function public.source_region_anchor_unique_block_v4(p_article_id uuid,p_source_region_id uuid,p_anchor text)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
select coalesce(sum(public.normalized_occurrence_count_v4(b.block_text,p_anchor)),0)=1
from public.formal_source_grounded_article_blocks_v4 b
where b.article_id=p_article_id and b.source_region_id=p_source_region_id;
$$;

create function public.validate_article_review_anchor_v4_row()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_review public.full_corpus_article_reviews_v4%rowtype;
  v_target public.source_region_coverage_targets_v4%rowtype;
begin
  select * into v_review from public.full_corpus_article_reviews_v4 where id=new.review_id;
  if not found then raise exception using errcode='23514',message='review_anchor_review_missing'; end if;
  if new.source_kind<>'source_region' then raise exception using errcode='23514',message='review_anchor_source_kind_must_be_source_region'; end if;

  select * into v_target
  from public.source_region_coverage_targets_v4
  where article_id=v_review.article_id and source_region_id=v_review.source_region_id and anchor_slot=new.anchor_slot;
  if not found then raise exception using errcode='23514',message='review_anchor_target_slot_not_required'; end if;
  if new.source_block_index<>v_target.block_index then raise exception using errcode='23514',message='review_anchor_wrong_source_block'; end if;
  if public.normalized_occurrence_count_v4(v_target.block_text,new.anchor_text)<>1 then raise exception using errcode='23514',message='review_anchor_not_unique_in_target_block'; end if;
  new.source_block_sha256:=v_target.source_block_sha256;
  return new;
end $$;

create trigger full_corpus_article_review_anchors_v4_validate
before insert or update on public.full_corpus_article_review_anchors_v4
for each row execute function public.validate_article_review_anchor_v4_row();

create function public.article_review_anchor_integrity_v4(p_review_id uuid)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
with r as (
  select * from public.full_corpus_article_reviews_v4 where id=p_review_id
), expected as (
  select t.* from r join public.source_region_coverage_targets_v4 t on t.article_id=r.article_id and t.source_region_id=r.source_region_id
), actual as (
  select a.* from public.full_corpus_article_review_anchors_v4 a where a.review_id=p_review_id
)
select exists(select 1 from r)
   and (select count(*) from expected)=(select count(*) from actual)
   and not exists(
     select 1 from expected e
     left join actual a on a.anchor_slot=e.anchor_slot
     where a.id is null
        or a.source_kind<>'source_region'
        or a.source_block_index<>e.block_index
        or a.source_block_sha256<>e.source_block_sha256
        or public.normalized_occurrence_count_v4(e.block_text,a.anchor_text)<>1
   )
   and not exists(select 1 from actual a left join expected e on e.anchor_slot=a.anchor_slot where e.anchor_slot is null);
$$;

revoke all on table public.formal_source_grounded_article_blocks_v4 from anon,authenticated;
revoke all on table public.source_region_coverage_targets_v4 from anon,authenticated;
grant select on table public.formal_source_grounded_article_blocks_v4 to service_role;
grant select on table public.source_region_coverage_targets_v4 to service_role;
revoke execute on function public.source_region_anchor_unique_block_v4(uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.validate_article_review_anchor_v4_row() from public,anon,authenticated;
revoke execute on function public.article_review_anchor_integrity_v4(uuid) from public,anon,authenticated;
grant execute on function public.source_region_anchor_unique_block_v4(uuid,uuid,text) to service_role;
grant execute on function public.validate_article_review_anchor_v4_row() to service_role;
grant execute on function public.article_review_anchor_integrity_v4(uuid) to service_role;
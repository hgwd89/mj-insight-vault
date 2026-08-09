create table if not exists public.source_ocr_block_assignments_v2 (
  source_image_id uuid not null,
  page_index integer not null,
  block_index integer not null,
  assignment_version text not null default 'source_block_partition_v2',
  assignment_kind text not null check(assignment_kind in ('article','non_article')),
  article_id uuid references public.articles(id) on delete cascade,
  non_article_role text,
  assignment_confidence numeric check(assignment_confidence is null or (assignment_confidence>=0 and assignment_confidence<=1)),
  assignment_reason text,
  source_ocr_json_sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(source_image_id,page_index,block_index,assignment_version),
  foreign key(source_image_id,page_index,block_index)
    references public.source_ocr_blocks_v1(source_image_id,page_index,block_index) on delete cascade,
  check((assignment_kind='article' and article_id is not null and non_article_role is null)
     or (assignment_kind='non_article' and article_id is null and coalesce(btrim(non_article_role),'')<>''))
);

create index if not exists source_ocr_block_assignments_v2_article_idx
 on public.source_ocr_block_assignments_v2(article_id)
 where article_id is not null;

create or replace function public.enforce_source_block_assignment_v2()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
declare v_source uuid; v_current_hash text;begin
  if new.assignment_version<>'source_block_partition_v2' then
    raise exception 'unsupported_source_block_assignment_version';
  end if;
  select source_image_id into v_source from public.articles where id=new.article_id;
  if new.assignment_kind='article' and (v_source is null or v_source<>new.source_image_id) then
    raise exception 'assigned_article_source_image_mismatch';
  end if;
  select source_ocr_json_sha256 into v_current_hash
  from public.source_ocr_blocks_v1
  where source_image_id=new.source_image_id and page_index=new.page_index and block_index=new.block_index;
  if v_current_hash is null or new.source_ocr_json_sha256<>v_current_hash then
    raise exception 'source_block_assignment_ocr_hash_mismatch';
  end if;
  new.updated_at:=now();
  return new;
end;
$$;

drop trigger if exists trg_enforce_source_block_assignment_v2 on public.source_ocr_block_assignments_v2;
create trigger trg_enforce_source_block_assignment_v2
before insert or update on public.source_ocr_block_assignments_v2
for each row execute function public.enforce_source_block_assignment_v2();

create or replace view public.source_page_block_partition_gate_v2 as
with source_pages as (
  select distinct f.source_image_id,b.page_index
  from public.formal_corpus_articles_v1 f
  join public.source_ocr_blocks_v1 b on b.source_image_id=f.source_image_id
), expected as (
  select p.source_image_id,p.page_index,count(*)::integer expected_block_count
  from source_pages p
  join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index
  group by p.source_image_id,p.page_index
), assigned as (
  select a.source_image_id,a.page_index,
         count(*)::integer assigned_block_count,
         count(*) filter(where a.assignment_kind='article')::integer article_block_count,
         count(*) filter(where a.assignment_kind='non_article')::integer non_article_block_count,
         count(*) filter(where a.assignment_confidence is null or a.assignment_confidence<0.80)::integer low_confidence_block_count,
         count(*) filter(where a.source_ocr_json_sha256<>b.source_ocr_json_sha256)::integer stale_block_count
  from public.source_ocr_block_assignments_v2 a
  join public.source_ocr_blocks_v1 b using(source_image_id,page_index,block_index)
  where a.assignment_version='source_block_partition_v2'
  group by a.source_image_id,a.page_index
), invalid_article as (
  select a.source_image_id,a.page_index,count(*)::integer invalid_article_assignment_count
  from public.source_ocr_block_assignments_v2 a
  left join public.formal_corpus_articles_v1 f on f.id=a.article_id
  where a.assignment_version='source_block_partition_v2'
    and a.assignment_kind='article'
    and f.id is null
  group by a.source_image_id,a.page_index
)
select e.source_image_id,e.page_index,e.expected_block_count,
       coalesce(a.assigned_block_count,0) assigned_block_count,
       coalesce(a.article_block_count,0) article_block_count,
       coalesce(a.non_article_block_count,0) non_article_block_count,
       e.expected_block_count-coalesce(a.assigned_block_count,0) unassigned_block_count,
       coalesce(a.low_confidence_block_count,0) low_confidence_block_count,
       coalesce(a.stale_block_count,0) stale_block_count,
       coalesce(i.invalid_article_assignment_count,0) invalid_article_assignment_count,
       case
         when e.expected_block_count=0 then 'failed'
         when coalesce(a.assigned_block_count,0)<>e.expected_block_count then 'failed'
         when coalesce(a.low_confidence_block_count,0)>0 then 'failed'
         when coalesce(a.stale_block_count,0)>0 then 'failed'
         when coalesce(i.invalid_article_assignment_count,0)>0 then 'failed'
         else 'passed'
       end partition_gate,
       case
         when e.expected_block_count=0 then 'no_ocr_blocks'
         when coalesce(a.assigned_block_count,0)<>e.expected_block_count then 'source_page_has_unassigned_blocks'
         when coalesce(a.low_confidence_block_count,0)>0 then 'low_confidence_block_assignments_exist'
         when coalesce(a.stale_block_count,0)>0 then 'stale_block_assignments_exist'
         when coalesce(i.invalid_article_assignment_count,0)>0 then 'block_assigned_to_nonformal_article'
         else 'passed'
       end gate_reason
from expected e
left join assigned a using(source_image_id,page_index)
left join invalid_article i using(source_image_id,page_index);

alter table public.article_source_regions
  add column if not exists block_partition_version text,
  add column if not exists assigned_block_count integer,
  add column if not exists partition_fingerprint text;

create or replace view public.article_source_region_integrity_v2 as
with blocksets as (
  select a.article_id,a.source_image_id,
         count(*)::integer block_count,
         min(b.x_min) x_min,min(b.y_min) y_min,max(b.x_max) x_max,max(b.y_max) y_max,
         string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index) source_region_text,
         encode(extensions.digest(convert_to(string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index),'UTF8'),'sha256'::text),'hex') source_region_sha256,
         encode(extensions.digest(convert_to(string_agg(a.page_index::text||':'||a.block_index::text||':'||a.source_ocr_json_sha256,E'|' order by a.page_index,a.block_index),'UTF8'),'sha256'::text),'hex') partition_fingerprint,
         count(*) filter(where similarity(public.normalize_article_headline_v1(v.headline),public.normalize_article_headline_v1(b.block_text))>=0.20)::integer headline_matching_block_count
  from public.source_ocr_block_assignments_v2 a
  join public.source_ocr_blocks_v1 b using(source_image_id,page_index,block_index)
  join public.formal_article_analysis_text_v2 v on v.article_id=a.article_id and v.source_image_id=a.source_image_id
  where a.assignment_version='source_block_partition_v2' and a.assignment_kind='article'
  group by a.article_id,a.source_image_id
)
select v.article_id,v.source_image_id,v.headline,v.analysis_body,v.analysis_body_sha256,
       r.id source_region_id,r.region_version,r.mapping_method,r.mapping_confidence,r.quality_status,r.quality_reason,
       bs.block_count,bs.x_min,bs.y_min,bs.x_max,bs.y_max,bs.source_region_text,bs.source_region_sha256,bs.partition_fingerprint,
       bs.headline_matching_block_count,p.partition_gate,p.gate_reason partition_gate_reason,
       case
         when r.id is null then 'failed'
         when r.region_version<>'source_region_v2_blockset' then 'failed'
         when r.block_partition_version<>'source_block_partition_v2' then 'failed'
         when r.quality_status<>'passed' then 'failed'
         when p.partition_gate<>'passed' then 'failed'
         when bs.block_count is null or bs.block_count<1 then 'failed'
         when bs.headline_matching_block_count<1 then 'failed'
         when r.assigned_block_count<>bs.block_count then 'failed'
         when r.partition_fingerprint<>bs.partition_fingerprint then 'failed'
         when r.source_region_sha256<>bs.source_region_sha256 then 'failed'
         when r.source_region_text<>bs.source_region_text then 'failed'
         when r.source_clean_body_sha256<>v.analysis_body_sha256 then 'failed'
         when r.source_image_raw_ocr_sha256<>v.source_raw_ocr_sha256 then 'failed'
         else 'passed'
       end integrity_gate,
       case
         when r.id is null then 'source_region_missing'
         when r.region_version<>'source_region_v2_blockset' then 'source_region_version_mismatch'
         when r.block_partition_version<>'source_block_partition_v2' then 'block_partition_version_mismatch'
         when r.quality_status<>'passed' then coalesce(r.quality_reason,'source_region_not_passed')
         when p.partition_gate<>'passed' then p.gate_reason
         when bs.block_count is null or bs.block_count<1 then 'article_has_no_assigned_source_blocks'
         when bs.headline_matching_block_count<1 then 'assigned_blocks_do_not_ground_headline'
         when r.assigned_block_count<>bs.block_count then 'assigned_block_count_mismatch'
         when r.partition_fingerprint<>bs.partition_fingerprint then 'partition_fingerprint_mismatch'
         when r.source_region_sha256<>bs.source_region_sha256 then 'source_region_sha_mismatch'
         when r.source_region_text<>bs.source_region_text then 'source_region_text_mismatch'
         when r.source_clean_body_sha256<>v.analysis_body_sha256 then 'clean_body_sha_mismatch'
         when r.source_image_raw_ocr_sha256<>v.source_raw_ocr_sha256 then 'source_ocr_sha_mismatch'
         else 'passed'
       end integrity_reason
from public.formal_article_analysis_text_v2 v
left join public.article_source_regions r on r.article_id=v.article_id and r.source_image_id=v.source_image_id and r.region_version='source_region_v2_blockset'
left join blocksets bs on bs.article_id=v.article_id and bs.source_image_id=v.source_image_id
left join public.source_page_block_partition_gate_v2 p on p.source_image_id=v.source_image_id and p.page_index=0;

create or replace view public.formal_source_grounded_articles_v2 as
select i.*
from public.article_source_region_integrity_v2 i
where i.integrity_gate='passed';

create or replace view public.article_source_region_gate_v2 as
select count(*)::integer formal_article_count,
       count(*) filter(where integrity_gate='passed')::integer source_grounded_article_count,
       count(*) filter(where integrity_gate<>'passed')::integer missing_or_invalid_source_region_count,
       count(distinct source_image_id)::integer source_page_count,
       count(distinct source_image_id) filter(where partition_gate='passed')::integer partition_complete_source_page_count,
       case when count(*)>0 and count(*) filter(where integrity_gate='passed')=count(*) then 'passed' else 'failed' end source_region_gate,
       case when count(*)=0 then 'no_formal_articles'
            when count(*) filter(where partition_gate<>'passed')>0 then 'source_page_partition_incomplete'
            when count(*) filter(where integrity_gate<>'passed')>0 then 'article_source_region_incomplete'
            else 'passed' end gate_reason
from public.article_source_region_integrity_v2;
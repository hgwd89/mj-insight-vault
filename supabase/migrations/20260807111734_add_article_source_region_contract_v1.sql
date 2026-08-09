create table if not exists public.article_source_regions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  source_image_id uuid not null references public.source_images(id) on delete cascade,
  region_version text not null,
  page_index integer not null default 0,
  x_min integer,
  y_min integer,
  x_max integer,
  y_max integer,
  mapping_method text not null,
  mapping_confidence numeric,
  headline_anchor text not null default '',
  headline_similarity numeric,
  source_region_text text not null default '',
  source_region_sha256 text not null default '',
  source_image_raw_ocr_sha256 text not null default '',
  source_clean_body_sha256 text not null default '',
  quality_status text not null default 'pending',
  quality_reason text,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(article_id,region_version),
  check(page_index>=0),
  check(x_min is null or x_min>=0),
  check(y_min is null or y_min>=0),
  check(x_max is null or x_max>=0),
  check(y_max is null or y_max>=0),
  check(x_min is null or x_max is null or x_max>x_min),
  check(y_min is null or y_max is null or y_max>y_min),
  check(mapping_confidence is null or (mapping_confidence>=0 and mapping_confidence<=1)),
  check(headline_similarity is null or (headline_similarity>=0 and headline_similarity<=1))
);

create index if not exists article_source_regions_article_idx on public.article_source_regions(article_id);
create index if not exists article_source_regions_source_idx on public.article_source_regions(source_image_id);
create index if not exists article_source_regions_quality_idx on public.article_source_regions(region_version,quality_status);

alter table public.article_source_regions enable row level security;
revoke all on public.article_source_regions from public,anon,authenticated;
grant select,insert,update,delete on public.article_source_regions to service_role;

create or replace view public.formal_source_grounded_articles_v1
with (security_invoker=true)
as
select v.article_id,v.headline,v.article_date,v.article_type,v.source_image_id,
       v.analysis_body,v.analysis_body_sha256,v.analysis_body_chars,
       r.id source_region_id,r.region_version,r.page_index,r.x_min,r.y_min,r.x_max,r.y_max,
       r.mapping_method,r.mapping_confidence,r.headline_anchor,r.headline_similarity,
       r.source_region_text,r.source_region_sha256,r.source_image_raw_ocr_sha256,
       v.source_raw_ocr_sha256 current_source_raw_ocr_sha256,
       r.quality_status,r.quality_reason
from public.formal_article_analysis_text_v2 v
join public.article_source_regions r on r.article_id=v.article_id and r.source_image_id=v.source_image_id
where r.region_version='source_region_v1_layout_ocr'
  and r.quality_status='passed'
  and r.source_clean_body_sha256=v.analysis_body_sha256
  and r.source_image_raw_ocr_sha256=v.source_raw_ocr_sha256
  and coalesce(r.source_region_text,'')<>''
  and coalesce(r.source_region_sha256,'') ~ '^[0-9a-f]{64}$';

create or replace view public.article_source_region_gate_v1
with (security_invoker=true)
as
with formal as (select article_id from public.formal_article_analysis_text_v2), grounded as (select article_id from public.formal_source_grounded_articles_v1)
select (select count(*)::integer from formal) formal_article_count,
       (select count(*)::integer from grounded) source_grounded_article_count,
       (select count(*)::integer from formal f left join grounded g on g.article_id=f.article_id where g.article_id is null) missing_source_region_count,
       case when (select count(*) from formal)>0 and (select count(*) from formal)=(select count(*) from grounded) then 'passed' else 'failed' end source_region_gate,
       case when (select count(*) from formal)=0 then 'no_formal_articles'
            when (select count(*) from formal)<>(select count(*) from grounded) then 'source_region_mapping_incomplete'
            else 'passed' end gate_reason;

revoke all on public.formal_source_grounded_articles_v1 from public,anon,authenticated;
revoke all on public.article_source_region_gate_v1 from public,anon,authenticated;
grant select on public.formal_source_grounded_articles_v1 to postgres,service_role;
grant select on public.article_source_region_gate_v1 to postgres,service_role;
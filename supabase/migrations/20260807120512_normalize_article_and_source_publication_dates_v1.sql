create or replace function public.normalize_mj_article_date_v1(p_value text)
returns date
language plpgsql
immutable
set search_path to 'pg_catalog','public'
as $$
declare v text:=btrim(coalesce(p_value,'')); m text[];begin
  if v='' then return null; end if;
  if v ~ '^\d{4}-\d{2}-\d{2}$' then
    begin return v::date; exception when others then return null; end;
  end if;
  m:=regexp_match(v,'^(\d{4})年(\d{1,2})月(\d{1,2})日$');
  if m is not null then
    begin return make_date(m[1]::int,m[2]::int,m[3]::int); exception when others then return null; end;
  end if;
  return null;
end;
$$;

create or replace function public.extract_mj_publication_date_v1(p_ocr text)
returns date
language plpgsql
immutable
set search_path to 'pg_catalog','public'
as $$
declare v text:=coalesce(p_ocr,''); m text[];begin
  m:=regexp_match(left(v,1200),'2026年[^\n]{0,40}([0-9]{1,2})月([0-9]{1,2})日');
  if m is null then m:=regexp_match(left(v,240),'([0-9]{1,2})月([0-9]{1,2})日'); end if;
  if m is null then return null; end if;
  begin return make_date(2026,m[1]::int,m[2]::int); exception when others then return null; end;
end;
$$;

alter table public.articles
  add column if not exists article_date_normalized date,
  add column if not exists article_date_normalization_version text;

create or replace function public.trg_normalize_article_date_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
begin
  new.article_date_normalized:=public.normalize_mj_article_date_v1(new.article_date);
  new.article_date_normalization_version:='normalize_mj_article_date_v1';
  return new;
end;
$$;

drop trigger if exists trg_normalize_article_date_v1 on public.articles;
create trigger trg_normalize_article_date_v1
before insert or update of article_date on public.articles
for each row execute function public.trg_normalize_article_date_v1();

update public.articles set
  article_date_normalized=public.normalize_mj_article_date_v1(article_date),
  article_date_normalization_version='normalize_mj_article_date_v1'
where article_date_normalized is distinct from public.normalize_mj_article_date_v1(article_date)
   or article_date_normalization_version is distinct from 'normalize_mj_article_date_v1';

create index if not exists articles_article_date_normalized_idx on public.articles(article_date_normalized);

alter table public.source_images
  add column if not exists publication_date date,
  add column if not exists publication_date_method text,
  add column if not exists publication_date_quality_status text,
  add column if not exists publication_date_source_ocr_sha256 text;

create or replace function public.trg_extract_source_publication_date_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
declare d date;begin
  d:=public.extract_mj_publication_date_v1(new.ocr_text_raw);
  new.publication_date:=d;
  new.publication_date_method:=case when d is not null then 'ocr_header_v1' else 'unresolved' end;
  new.publication_date_quality_status:=case when d is not null then 'passed' else 'pending' end;
  new.publication_date_source_ocr_sha256:=new.raw_ocr_sha256;
  return new;
end;
$$;

drop trigger if exists trg_extract_source_publication_date_v1 on public.source_images;
create trigger trg_extract_source_publication_date_v1
before insert or update of ocr_text_raw,raw_ocr_sha256 on public.source_images
for each row execute function public.trg_extract_source_publication_date_v1();

update public.source_images set
  publication_date=public.extract_mj_publication_date_v1(ocr_text_raw),
  publication_date_method=case when public.extract_mj_publication_date_v1(ocr_text_raw) is not null then 'ocr_header_v1' else 'unresolved' end,
  publication_date_quality_status=case when public.extract_mj_publication_date_v1(ocr_text_raw) is not null then 'passed' else 'pending' end,
  publication_date_source_ocr_sha256=raw_ocr_sha256
where ocr_text_raw is not null;

create or replace view public.article_date_integrity_v1 as
select f.id as article_id,f.source_image_id,f.article_date,a.article_date_normalized,
       s.publication_date,s.publication_date_method,s.publication_date_quality_status,
       case
         when a.article_date_normalized is null then 'failed'
         when s.publication_date_quality_status<>'passed' or s.publication_date is null then 'pending'
         when a.article_date_normalized=s.publication_date then 'passed'
         else 'failed'
       end as date_integrity_status,
       case
         when a.article_date_normalized is null then 'article_date_unparseable'
         when s.publication_date_quality_status<>'passed' or s.publication_date is null then 'source_publication_date_unresolved'
         when a.article_date_normalized<>s.publication_date then 'article_date_differs_from_source_publication_date'
         else 'passed'
       end as date_integrity_reason
from public.formal_corpus_articles_v1 f
join public.articles a on a.id=f.id
join public.source_images s on s.id=f.source_image_id;
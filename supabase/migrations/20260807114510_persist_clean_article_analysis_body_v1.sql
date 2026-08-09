alter table public.articles
  add column if not exists analysis_body_clean text,
  add column if not exists analysis_body_clean_sha256 text,
  add column if not exists analysis_body_clean_version text;

create or replace function public.refresh_article_clean_body_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
declare
  v_clean text;
begin
  v_clean := public.clean_article_analysis_body_v1(new.ocr_text);
  new.analysis_body_clean := v_clean;
  new.analysis_body_clean_sha256 := encode(digest(convert_to(coalesce(v_clean,''),'UTF8'),'sha256'),'hex');
  new.analysis_body_clean_version := 'clean_article_analysis_body_v1';
  return new;
end;
$$;

update public.articles
set analysis_body_clean = public.clean_article_analysis_body_v1(ocr_text),
    analysis_body_clean_sha256 = encode(digest(convert_to(coalesce(public.clean_article_analysis_body_v1(ocr_text),''),'UTF8'),'sha256'),'hex'),
    analysis_body_clean_version = 'clean_article_analysis_body_v1'
where analysis_body_clean is distinct from public.clean_article_analysis_body_v1(ocr_text)
   or analysis_body_clean_sha256 is distinct from encode(digest(convert_to(coalesce(public.clean_article_analysis_body_v1(ocr_text),''),'UTF8'),'sha256'),'hex')
   or analysis_body_clean_version is distinct from 'clean_article_analysis_body_v1';

drop trigger if exists trg_refresh_article_clean_body_v1 on public.articles;
create trigger trg_refresh_article_clean_body_v1
before insert or update of ocr_text on public.articles
for each row execute function public.refresh_article_clean_body_v1();

create index if not exists articles_analysis_body_clean_sha256_idx
  on public.articles(analysis_body_clean_sha256)
  where analysis_body_clean_sha256 is not null;

create or replace view public.formal_article_analysis_text_v2 as
select
  f.id as article_id,
  f.headline,
  f.article_date,
  f.article_type,
  f.source_image_id,
  a.analysis_body_clean as analysis_body,
  a.analysis_body_clean_sha256 as analysis_body_sha256,
  length(a.analysis_body_clean) as analysis_body_chars,
  s.ocr_text_raw as source_ocr_text,
  s.raw_ocr_sha256 as source_raw_ocr_sha256,
  s.normalized_ocr_sha256 as source_normalized_ocr_sha256,
  f.analysis_text_sha256 as legacy_analysis_text_sha256,
  f.reconstruction_confidence,
  f.provenance_status
from public.formal_corpus_articles_v1 f
join public.articles a on a.id=f.id
join public.source_images s on s.id=f.source_image_id
where coalesce(a.analysis_body_clean,'')<>''
  and a.analysis_body_clean_version='clean_article_analysis_body_v1'
  and coalesce(s.ocr_text_raw,'')<>'';
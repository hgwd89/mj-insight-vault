alter table public.articles
  add column if not exists hard_advertisement_flag boolean not null default false,
  add column if not exists content_role_version text;

create or replace function public.refresh_article_content_role_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
begin
  new.hard_advertisement_flag:=public.is_hard_advertisement_v1(new.headline,new.analysis_body_clean);
  new.content_role_version:='hard_advertisement_v1';
  return new;
end;
$$;

drop trigger if exists trg_zz_refresh_article_content_role_v1 on public.articles;
create trigger trg_zz_refresh_article_content_role_v1
before insert or update of headline,ocr_text,analysis_body_clean on public.articles
for each row execute function public.refresh_article_content_role_v1();

update public.articles
set hard_advertisement_flag=public.is_hard_advertisement_v1(headline,analysis_body_clean),
    content_role_version='hard_advertisement_v1'
where hard_advertisement_flag is distinct from public.is_hard_advertisement_v1(headline,analysis_body_clean)
   or content_role_version is distinct from 'hard_advertisement_v1';

create index if not exists articles_hard_advertisement_flag_idx
on public.articles(hard_advertisement_flag)
where hard_advertisement_flag;

create or replace view public.article_content_role_audit_v1 as
select a.id as article_id,a.headline,a.article_date,a.article_date_normalized,
       a.hard_advertisement_flag as hard_advertisement,
       case when a.hard_advertisement_flag then 'advertisement' else 'not_hard_advertisement' end as content_role_status
from public.articles a
where (a.status is null or a.status not in ('deleted','excluded','rejected'))
  and coalesce(a.article_type,'')='article';

create or replace view public.formal_corpus_articles_v1 as
select
    a.id,a.batch_id,a.source_image_id,a.headline,a.article_date,a.article_index,a.ocr_text,a.article_type,
    a.has_table,a.has_chart,a.has_image,a.status,a.manual_analysis,a.created_at,a.updated_at,
    a.duplicate_of_article_id,a.exclusion_reason,a.enrichment_status,a.enrichment_error,
    a.analysis_text_origin,a.source_ocr_sha256,a.analysis_text_sha256,a.reconstruction_model,
    a.reconstruction_prompt_version,a.reconstruction_confidence,a.provenance_status,a.provenance_json
from public.articles a
join public.source_images s on s.id=a.source_image_id
join public.source_publication_date_effective_v1 d on d.source_image_id=a.source_image_id
where (a.status is null or a.status not in ('deleted','excluded','rejected'))
  and coalesce(a.article_type,'')='article'
  and coalesce(btrim(a.ocr_text),'')<>''
  and a.source_image_id is not null
  and s.duplicate_of_source_image_id is null
  and a.provenance_status in ('traceable','legacy_traceable')
  and coalesce(a.source_ocr_sha256,'') ~ '^[0-9a-f]{64}$'
  and coalesce(a.analysis_text_sha256,'') ~ '^[0-9a-f]{64}$'
  and a.analysis_text_origin<>'pending'
  and a.duplicate_of_article_id is null
  and a.article_date_normalized is not null
  and a.article_date_normalization_version='normalize_mj_article_date_v1'
  and d.publication_date_quality_status='passed'
  and d.publication_date=a.article_date_normalized
  and not a.hard_advertisement_flag
  and a.content_role_version='hard_advertisement_v1';
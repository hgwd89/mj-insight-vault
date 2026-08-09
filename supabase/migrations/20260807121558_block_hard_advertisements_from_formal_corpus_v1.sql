create or replace function public.is_hard_advertisement_v1(p_headline text,p_clean_body text)
returns boolean
language sql
immutable
set search_path to 'pg_catalog','public'
as $$
select
  coalesce(p_clean_body,'') ~ '本紙面.{0,40}(全面|特集)?広告'
  or coalesce(p_headline,'') ~ '(出展者募集中|出展者募集)'
  or coalesce(p_headline,'') ~ '日経の記事.{0,30}額装サービス'
  or (
    coalesce(p_clean_body,'') ~ '(出展申込締切|早期申込割引)'
    and coalesce(p_clean_body,'') ~ '(出展料|出展小間料|出展対象|来場対象)'
  )
$$;

create or replace view public.article_content_role_audit_v1 as
select a.id as article_id,a.headline,a.article_date,a.article_date_normalized,
       public.is_hard_advertisement_v1(a.headline,a.analysis_body_clean) as hard_advertisement,
       case
         when public.is_hard_advertisement_v1(a.headline,a.analysis_body_clean) then 'advertisement'
         else 'not_hard_advertisement'
       end as content_role_status
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
join public.source_publication_date_effective_v1 d on d.source_image_id=a.source_image_id
where (a.status is null or a.status not in ('deleted','excluded','rejected'))
  and coalesce(a.article_type,'')='article'
  and coalesce(btrim(a.ocr_text),'')<>''
  and a.source_image_id is not null
  and a.provenance_status in ('traceable','legacy_traceable')
  and coalesce(a.source_ocr_sha256,'') ~ '^[0-9a-f]{64}$'
  and coalesce(a.analysis_text_sha256,'') ~ '^[0-9a-f]{64}$'
  and a.analysis_text_origin<>'pending'
  and a.duplicate_of_article_id is null
  and a.article_date_normalized is not null
  and a.article_date_normalization_version='normalize_mj_article_date_v1'
  and d.publication_date_quality_status='passed'
  and d.publication_date=a.article_date_normalized
  and not public.is_hard_advertisement_v1(a.headline,a.analysis_body_clean);
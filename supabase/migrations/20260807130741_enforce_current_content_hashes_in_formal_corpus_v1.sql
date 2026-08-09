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
  and coalesce(s.raw_ocr_sha256,'') ~ '^[0-9a-f]{64}$'
  and a.source_ocr_sha256=s.raw_ocr_sha256
  and a.analysis_text_sha256=encode(extensions.digest(convert_to(coalesce(a.ocr_text,''),'UTF8'),'sha256'::text),'hex')
  and a.analysis_body_clean_version='clean_article_analysis_body_v1'
  and a.analysis_body_clean_sha256=encode(extensions.digest(convert_to(coalesce(a.analysis_body_clean,''),'UTF8'),'sha256'::text),'hex')
  and coalesce(a.analysis_body_clean,'')<>''
  and a.analysis_text_origin<>'pending'
  and a.duplicate_of_article_id is null
  and a.article_date_normalized is not null
  and a.article_date_normalization_version='normalize_mj_article_date_v1'
  and d.publication_date_quality_status='passed'
  and d.publication_date=a.article_date_normalized
  and not a.hard_advertisement_flag
  and a.content_role_version='hard_advertisement_v1';
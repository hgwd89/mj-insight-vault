create or replace view public.source_publication_date_effective_v1 as
with batch_dates as (
  select batch_id,
         count(*) filter(where publication_date_quality_status='passed' and publication_date is not null)::integer as passed_source_count,
         count(distinct publication_date) filter(where publication_date_quality_status='passed' and publication_date is not null)::integer as distinct_date_count,
         min(publication_date) filter(where publication_date_quality_status='passed' and publication_date is not null) as consensus_date
  from public.source_images
  group by batch_id
)
select s.id as source_image_id,
       case
         when s.publication_date_quality_status='passed' and s.publication_date is not null then s.publication_date
         when b.passed_source_count>=2 and b.distinct_date_count=1 then b.consensus_date
         else null
       end as publication_date,
       case
         when s.publication_date_quality_status='passed' and s.publication_date is not null then s.publication_date_method
         when b.passed_source_count>=2 and b.distinct_date_count=1 then 'batch_consensus_v1'
         else 'unresolved'
       end as publication_date_method,
       case
         when s.publication_date_quality_status='passed' and s.publication_date is not null then 'passed'
         when b.passed_source_count>=2 and b.distinct_date_count=1 then 'passed'
         else 'pending'
       end as publication_date_quality_status,
       b.passed_source_count as batch_supporting_source_count,
       b.distinct_date_count as batch_distinct_date_count
from public.source_images s
left join batch_dates b on b.batch_id=s.batch_id;

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
  and d.publication_date=a.article_date_normalized;

create or replace view public.article_date_integrity_v1 as
select a.id as article_id,a.source_image_id,a.article_date,a.article_date_normalized,
       d.publication_date,d.publication_date_method,d.publication_date_quality_status,
       case
         when a.article_date_normalized is null then 'failed'
         when d.publication_date_quality_status<>'passed' or d.publication_date is null then 'pending'
         when a.article_date_normalized=d.publication_date then 'passed'
         else 'failed'
       end as date_integrity_status,
       case
         when a.article_date_normalized is null then 'article_date_unparseable'
         when d.publication_date_quality_status<>'passed' or d.publication_date is null then 'source_publication_date_unresolved'
         when a.article_date_normalized<>d.publication_date then 'article_date_differs_from_source_publication_date'
         else 'passed'
       end as date_integrity_reason
from public.articles a
join public.source_publication_date_effective_v1 d on d.source_image_id=a.source_image_id
where (a.status is null or a.status not in ('deleted','excluded','rejected'))
  and coalesce(a.article_type,'')='article'
  and a.duplicate_of_article_id is null;
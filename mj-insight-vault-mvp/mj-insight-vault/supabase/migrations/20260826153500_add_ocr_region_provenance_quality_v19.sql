-- Audit recovered Inventory article-to-region provenance independently of OCR glyph quality.
-- This is diagnostic only: it does not yet alter canonical OCR eligibility.
-- Strong/review thresholds intentionally fail closed for weak article mappings.

create or replace view public.ocr_region_provenance_quality_v19 as
select
  r.article_id,
  r.id as source_region_id,
  r.partition_job_id,
  r.mapping_method,
  r.mapping_confidence,
  r.headline_similarity as block_headline_similarity,
  similarity(
    public.normalize_article_headline_v1(f.headline),
    public.normalize_article_headline_v1(r.headline_anchor)
  )::numeric as anchor_headline_similarity,
  r.assigned_block_count,
  case
    when r.mapping_confidence >= 0.80
     and similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(r.headline_anchor)) >= 0.50
      then 'strong'
    when r.mapping_confidence >= 0.50
     and similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(r.headline_anchor)) >= 0.30
      then 'review'
    else 'low'
  end as provenance_quality_status,
  case
    when r.mapping_confidence < 0.50
     and similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(r.headline_anchor)) < 0.30
      then 'low_mapping_and_anchor_similarity'
    when r.mapping_confidence < 0.50 then 'low_mapping_confidence'
    when similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(r.headline_anchor)) < 0.30
      then 'low_anchor_similarity'
    when r.mapping_confidence < 0.80
      or similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(r.headline_anchor)) < 0.50
      then 'review_provenance'
    else 'strong_provenance'
  end as provenance_quality_reason
from public.article_source_regions r
join public.formal_corpus_articles_v1 f on f.id=r.article_id
where r.region_version='source_region_v7_recovered_inventory';

revoke all on public.ocr_region_provenance_quality_v19 from public, anon, authenticated;

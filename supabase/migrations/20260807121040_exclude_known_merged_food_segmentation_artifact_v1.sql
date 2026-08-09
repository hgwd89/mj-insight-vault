update public.articles
set status='excluded',
    duplicate_of_article_id=null,
    exclusion_reason='merged_segmentation_artifact_multiple_distinct_articles_v1',
    updated_at=now()
where article_date_normalized='2026-04-24'::date
  and headline ilike '円安で羊肉高騰%'
  and headline ilike '%明石焼き%'
  and headline ilike '%くら寿司%'
  and (status is null or status not in ('deleted','excluded','rejected'))
  and duplicate_of_article_id is null;
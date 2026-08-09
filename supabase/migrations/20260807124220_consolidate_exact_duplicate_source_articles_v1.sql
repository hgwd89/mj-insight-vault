alter table public.articles
  add column if not exists original_source_image_id uuid references public.source_images(id),
  add column if not exists original_batch_id uuid references public.upload_batches(id),
  add column if not exists source_rehoming_reason text;

with d as (
  select f.id,f.headline,a.article_date_normalized d,a.analysis_body_clean,f.source_image_id,s.batch_id original_batch_id,
         s.raw_ocr_sha256 original_raw_ocr_sha256,s.duplicate_of_source_image_id canonical_source,c.batch_id canonical_batch_id,c.raw_ocr_sha256 canonical_raw_ocr_sha256
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  join public.source_images s on s.id=f.source_image_id
  join public.source_images c on c.id=s.duplicate_of_source_image_id
  where s.duplicate_of_source_image_id is not null
    and s.normalized_ocr_sha256=c.normalized_ocr_sha256
), candidates as (
  select d.id,d.source_image_id,d.original_batch_id,d.original_raw_ocr_sha256,d.canonical_source,d.canonical_batch_id,d.canonical_raw_ocr_sha256,
         c.id canonical_article_id,
         similarity(public.normalize_article_headline_v1(d.headline),public.normalize_article_headline_v1(c.headline)) hsim,
         similarity(regexp_replace(d.analysis_body_clean,'\s+','','g'),regexp_replace(ca.analysis_body_clean,'\s+','','g')) bsim,
         row_number() over(partition by d.id order by greatest(similarity(public.normalize_article_headline_v1(d.headline),public.normalize_article_headline_v1(c.headline)),similarity(regexp_replace(d.analysis_body_clean,'\s+','','g'),regexp_replace(ca.analysis_body_clean,'\s+','','g'))) desc,c.id) rn
  from d
  join public.articles c on c.source_image_id=d.canonical_source
    and (c.status is null or c.status not in ('deleted','excluded','rejected'))
    and c.article_type='article' and c.article_date_normalized=d.d
  join public.articles ca on ca.id=c.id
), matched as (
  select * from candidates where rn=1 and (hsim>=0.55 or bsim>=0.50)
), excluded as (
  update public.articles a
  set status='excluded',duplicate_of_article_id=m.canonical_article_id,
      exclusion_reason='duplicate_article_from_exact_normalized_ocr_duplicate_source_v1',updated_at=now()
  from matched m where a.id=m.id
  returning a.id
), unmatched as (
  select d.* from d where not exists(select 1 from matched m where m.id=d.id)
), rehomed as (
  update public.articles a
  set original_source_image_id=coalesce(a.original_source_image_id,u.source_image_id),
      original_batch_id=coalesce(a.original_batch_id,u.original_batch_id),
      source_rehoming_reason='exact_normalized_ocr_equivalent_source_v1',
      source_image_id=u.canonical_source,
      batch_id=u.canonical_batch_id,
      source_ocr_sha256=u.canonical_raw_ocr_sha256,
      provenance_json=coalesce(a.provenance_json,'{}'::jsonb)||jsonb_build_object(
        'source_rehomed_from_image_id',u.source_image_id::text,
        'source_rehomed_to_image_id',u.canonical_source::text,
        'source_rehoming_reason','exact_normalized_ocr_equivalent_source_v1',
        'original_source_raw_ocr_sha256',u.original_raw_ocr_sha256,
        'effective_source_raw_ocr_sha256',u.canonical_raw_ocr_sha256
      ),
      updated_at=now()
  from unmatched u where a.id=u.id
  returning a.id
)
select (select count(*) from excluded)::integer excluded_duplicates,(select count(*) from rehomed)::integer rehomed_unique_articles;
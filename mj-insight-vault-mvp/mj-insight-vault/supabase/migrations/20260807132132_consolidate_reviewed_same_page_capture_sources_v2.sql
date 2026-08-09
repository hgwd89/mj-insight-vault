create table if not exists public.source_image_same_page_reviews_v2 (
  source_image_id uuid primary key references public.source_images(id) on delete cascade,
  canonical_source_image_id uuid not null references public.source_images(id),
  publication_date date not null,
  page_width integer not null,
  page_height integer not null,
  normalized_ocr_similarity double precision not null check(normalized_ocr_similarity>=0.95 and normalized_ocr_similarity<=1.0),
  review_version text not null default 'same_page_capture_review_v2',
  decision text not null default 'equivalent' check(decision='equivalent'),
  reason text not null,
  created_at timestamptz not null default now(),
  check(source_image_id<>canonical_source_image_id)
);

with pairs(loser,canonical_source) as (values
 ('db1f9e68-d85f-47ed-9cf5-814c4344579c'::uuid,'69bfdf1a-2f99-4e83-ae11-e4954d4f7f44'::uuid),
 ('ff2c5e6f-7189-4ab3-a100-5956046e8ee9'::uuid,'e8b51d4e-c690-452b-be77-901931f92573'::uuid),
 ('e599387f-637a-4d2a-b604-59a03bc1487a'::uuid,'8ffef74c-85b0-4996-aed9-d64cdecdd4ae'::uuid)
), verified as (
 select p.loser,p.canonical_source,
        dl.publication_date,
        (l.ocr_json->'fullTextAnnotation'->'pages'->0->>'width')::integer page_width,
        (l.ocr_json->'fullTextAnnotation'->'pages'->0->>'height')::integer page_height,
        similarity(regexp_replace(lower(l.ocr_text_raw),'[[:space:]]+','','g'),regexp_replace(lower(c.ocr_text_raw),'[[:space:]]+','','g'))::double precision ocr_similarity,
        l.batch_id loser_batch,l.raw_ocr_sha256 loser_raw_sha,c.batch_id canonical_batch,c.raw_ocr_sha256 canonical_raw_sha
 from pairs p
 join public.source_images l on l.id=p.loser
 join public.source_images c on c.id=p.canonical_source
 join public.source_publication_date_effective_v1 dl on dl.source_image_id=p.loser
 join public.source_publication_date_effective_v1 dc on dc.source_image_id=p.canonical_source
 where dl.publication_date=dc.publication_date
   and (l.ocr_json->'fullTextAnnotation'->'pages'->0->>'width')::integer=(c.ocr_json->'fullTextAnnotation'->'pages'->0->>'width')::integer
   and (l.ocr_json->'fullTextAnnotation'->'pages'->0->>'height')::integer=(c.ocr_json->'fullTextAnnotation'->'pages'->0->>'height')::integer
   and similarity(regexp_replace(lower(l.ocr_text_raw),'[[:space:]]+','','g'),regexp_replace(lower(c.ocr_text_raw),'[[:space:]]+','','g'))>=0.95
), audit_insert as (
 insert into public.source_image_same_page_reviews_v2(source_image_id,canonical_source_image_id,publication_date,page_width,page_height,normalized_ocr_similarity,reason)
 select loser,canonical_source,publication_date,page_width,page_height,ocr_similarity,'reviewed_same_newspaper_page_same_dimensions_and_normalized_ocr_similarity_ge_0_95_v2'
 from verified
 on conflict(source_image_id) do update set canonical_source_image_id=excluded.canonical_source_image_id,publication_date=excluded.publication_date,page_width=excluded.page_width,page_height=excluded.page_height,normalized_ocr_similarity=excluded.normalized_ocr_similarity,reason=excluded.reason
 returning source_image_id
), rehomed as (
 update public.articles a
 set original_source_image_id=coalesce(a.original_source_image_id,a.source_image_id),
     original_batch_id=coalesce(a.original_batch_id,a.batch_id),
     original_article_index=coalesce(a.original_article_index,a.article_index),
     source_rehoming_reason='same_page_capture_review_v2',
     source_image_id=v.canonical_source,
     batch_id=v.canonical_batch,
     source_ocr_sha256=v.canonical_raw_sha,
     provenance_json=coalesce(a.provenance_json,'{}'::jsonb)||jsonb_build_object(
       'source_rehomed_from_image_id',v.loser::text,
       'source_rehomed_to_image_id',v.canonical_source::text,
       'source_rehoming_reason','same_page_capture_review_v2',
       'reviewed_normalized_ocr_similarity',v.ocr_similarity,
       'original_source_raw_ocr_sha256',v.loser_raw_sha,
       'effective_source_raw_ocr_sha256',v.canonical_raw_sha
     ),updated_at=now()
 from verified v
 where a.source_image_id=v.loser and (a.status is null or a.status not in ('deleted','excluded','rejected'))
 returning a.id
), marked as (
 update public.source_images s
 set duplicate_of_source_image_id=v.canonical_source,duplicate_reason='same_page_capture_review_v2'
 from verified v where s.id=v.loser returning s.id
)
select (select count(*) from verified)::integer verified_pairs,(select count(*) from rehomed)::integer rehomed_articles,(select count(*) from marked)::integer marked_sources,(select count(*) from audit_insert)::integer audit_rows;
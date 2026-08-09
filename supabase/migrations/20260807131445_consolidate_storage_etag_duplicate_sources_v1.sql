create table if not exists public.source_storage_identity_reviews_v1 (
  source_image_id uuid primary key references public.source_images(id) on delete cascade,
  canonical_source_image_id uuid not null references public.source_images(id),
  storage_etag text not null,
  storage_size_bytes bigint not null,
  review_version text not null default 'storage_etag_size_exact_v1',
  decision text not null default 'equivalent' check(decision='equivalent'),
  reason text not null,
  created_at timestamptz not null default now(),
  check(source_image_id<>canonical_source_image_id)
);

with chosen(storage_etag,storage_size_bytes,canonical_source) as (values
 ('\"18174b92d700f8c372d6749ffcbdc48e\"'::text,1128116::bigint,'c9a1a99e-f9c5-4b61-9908-d3057a417c4d'::uuid),
 ('\"197be5a150444871dca89a69ee16b111\"'::text,1293917::bigint,'fbd1e1af-d336-4081-93a7-c2be937f97d8'::uuid),
 ('\"3020a0feef6c4673568dbce81feb7343\"'::text,1039571::bigint,'e30ffbb5-b174-4ddc-b19b-2f8ecf3c183a'::uuid),
 ('\"5aaf5dbd25e628af48eb325048e2543a\"'::text,1042076::bigint,'a10c2e55-8de4-447f-9d2d-f8e3f6f93dff'::uuid),
 ('\"950471e035affa29d37a2e821939771b\"'::text,1154575::bigint,'9d1c8692-e94b-416e-9cf1-3d41782e11e4'::uuid)
), members as (
 select s.id loser,c.canonical_source,s.storage_etag,s.storage_size_bytes,s.batch_id loser_batch,s.raw_ocr_sha256 loser_raw_sha,
        sc.batch_id canonical_batch,sc.raw_ocr_sha256 canonical_raw_sha
 from public.source_images s join chosen c on c.storage_etag=s.storage_etag and c.storage_size_bytes=s.storage_size_bytes
 join public.source_images sc on sc.id=c.canonical_source
 where s.id<>c.canonical_source
   and s.id in (select distinct source_image_id from public.formal_corpus_articles_v1)
), audit_insert as (
 insert into public.source_storage_identity_reviews_v1(source_image_id,canonical_source_image_id,storage_etag,storage_size_bytes,reason)
 select loser,canonical_source,storage_etag,storage_size_bytes,'storage_object_etag_and_byte_size_exact_match_v1' from members
 on conflict(source_image_id) do update set canonical_source_image_id=excluded.canonical_source_image_id,storage_etag=excluded.storage_etag,storage_size_bytes=excluded.storage_size_bytes,reason=excluded.reason
 returning source_image_id
), rehomed as (
 update public.articles a
 set original_source_image_id=coalesce(a.original_source_image_id,a.source_image_id),
     original_batch_id=coalesce(a.original_batch_id,a.batch_id),
     source_rehoming_reason='storage_etag_size_exact_equivalent_source_v1',
     source_image_id=m.canonical_source,batch_id=m.canonical_batch,source_ocr_sha256=m.canonical_raw_sha,
     provenance_json=coalesce(a.provenance_json,'{}'::jsonb)||jsonb_build_object(
       'source_rehomed_from_image_id',m.loser::text,
       'source_rehomed_to_image_id',m.canonical_source::text,
       'source_rehoming_reason','storage_etag_size_exact_equivalent_source_v1',
       'storage_etag',m.storage_etag,
       'storage_size_bytes',m.storage_size_bytes,
       'original_source_raw_ocr_sha256',m.loser_raw_sha,
       'effective_source_raw_ocr_sha256',m.canonical_raw_sha
     ),updated_at=now()
 from members m
 where a.source_image_id=m.loser and (a.status is null or a.status not in ('deleted','excluded','rejected'))
 returning a.id
), marked as (
 update public.source_images s
 set duplicate_of_source_image_id=m.canonical_source,duplicate_reason='storage_etag_size_exact_equivalent_source_v1'
 from members m where s.id=m.loser returning s.id
)
select (select count(*) from rehomed)::integer rehomed_articles,(select count(*) from marked)::integer duplicate_sources_marked,(select count(*) from audit_insert)::integer audit_rows;
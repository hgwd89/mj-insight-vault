with pairs(loser,canonical_source) as (values
 ('617e9798-fbb3-4c94-b262-c988ec732c35'::uuid,'c9a1a99e-f9c5-4b61-9908-d3057a417c4d'::uuid),
 ('1685cbff-8d7b-44f7-aedd-3ff40ac14173'::uuid,'fbd1e1af-d336-4081-93a7-c2be937f97d8'::uuid),
 ('4eff6e54-de41-4452-922c-d30c6abd0ae0'::uuid,'e30ffbb5-b174-4ddc-b19b-2f8ecf3c183a'::uuid),
 ('18d9fd12-dd67-4ad5-8b4f-257f81efbd6c'::uuid,'a10c2e55-8de4-447f-9d2d-f8e3f6f93dff'::uuid),
 ('b8321dd1-d053-419c-9260-df38a62ff6f9'::uuid,'9d1c8692-e94b-416e-9cf1-3d41782e11e4'::uuid)
), verified as (
 select p.loser,p.canonical_source,l.storage_etag,l.storage_size_bytes,l.batch_id loser_batch,l.raw_ocr_sha256 loser_raw_sha,c.batch_id canonical_batch,c.raw_ocr_sha256 canonical_raw_sha
 from pairs p join public.source_images l on l.id=p.loser join public.source_images c on c.id=p.canonical_source
 where l.storage_etag is not null and l.storage_etag=c.storage_etag and l.storage_size_bytes is not null and l.storage_size_bytes=c.storage_size_bytes
), audit_insert as (
 insert into public.source_storage_identity_reviews_v1(source_image_id,canonical_source_image_id,storage_etag,storage_size_bytes,reason)
 select loser,canonical_source,storage_etag,storage_size_bytes,'storage_object_etag_and_byte_size_exact_match_v1' from verified
 on conflict(source_image_id) do update set canonical_source_image_id=excluded.canonical_source_image_id,storage_etag=excluded.storage_etag,storage_size_bytes=excluded.storage_size_bytes,reason=excluded.reason
 returning source_image_id
), rehomed as (
 update public.articles a
 set original_source_image_id=coalesce(a.original_source_image_id,a.source_image_id),original_batch_id=coalesce(a.original_batch_id,a.batch_id),
     source_rehoming_reason='storage_etag_size_exact_equivalent_source_v1',source_image_id=v.canonical_source,batch_id=v.canonical_batch,source_ocr_sha256=v.canonical_raw_sha,
     provenance_json=coalesce(a.provenance_json,'{}'::jsonb)||jsonb_build_object('source_rehomed_from_image_id',v.loser::text,'source_rehomed_to_image_id',v.canonical_source::text,'source_rehoming_reason','storage_etag_size_exact_equivalent_source_v1','storage_etag',v.storage_etag,'storage_size_bytes',v.storage_size_bytes,'original_source_raw_ocr_sha256',v.loser_raw_sha,'effective_source_raw_ocr_sha256',v.canonical_raw_sha),updated_at=now()
 from verified v where a.source_image_id=v.loser and (a.status is null or a.status not in ('deleted','excluded','rejected')) returning a.id
), marked as (
 update public.source_images s set duplicate_of_source_image_id=v.canonical_source,duplicate_reason='storage_etag_size_exact_equivalent_source_v1'
 from verified v where s.id=v.loser returning s.id
)
select (select count(*) from verified)::integer verified_pairs,(select count(*) from rehomed)::integer rehomed_articles,(select count(*) from marked)::integer marked_sources,(select count(*) from audit_insert)::integer audit_rows;
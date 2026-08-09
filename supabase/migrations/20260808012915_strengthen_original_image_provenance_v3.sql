begin;

alter table public.source_image_ingest_provenance_v2
  add column if not exists original_size_bytes bigint,
  add column if not exists original_mime_type text,
  add column if not exists ocr_derivative_size_bytes bigint,
  add column if not exists ocr_derivative_mime_type text,
  add column if not exists original_verified_at timestamptz;

alter table public.source_image_ingest_provenance_v2
  drop constraint if exists source_image_ingest_provenance_v2_strict_original_check;
alter table public.source_image_ingest_provenance_v2
  add constraint source_image_ingest_provenance_v2_strict_original_check
  check (
    ingest_mode='legacy_reencoded_derivative'
    or (
      original_available
      and coalesce(btrim(original_storage_path),'')<>''
      and original_sha256 ~ '^[0-9a-f]{64}$'
      and original_size_bytes is not null and original_size_bytes>0
      and coalesce(btrim(original_mime_type),'')<>''
      and original_verified_at is not null
    )
  );

alter table public.source_image_ingest_provenance_v2
  drop constraint if exists source_image_ingest_provenance_v2_derivative_check;
alter table public.source_image_ingest_provenance_v2
  add constraint source_image_ingest_provenance_v2_derivative_check
  check (
    ingest_mode<>'original_and_ocr_derivative'
    or (
      coalesce(btrim(ocr_derivative_storage_path),'')<>''
      and ocr_derivative_sha256 ~ '^[0-9a-f]{64}$'
      and ocr_derivative_size_bytes is not null and ocr_derivative_size_bytes>0
      and coalesce(btrim(ocr_derivative_mime_type),'')<>''
    )
  );

create or replace view public.source_image_ingest_provenance_gate_v3
with (security_invoker=true)
as
with fs as (
  select distinct a.source_image_id
  from public.formal_corpus_articles_v1 a
), s as (
  select
    count(*)::integer source_count,
    count(*) filter(where p.source_image_id is null)::integer missing_provenance,
    count(*) filter(where p.ingest_mode='legacy_reencoded_derivative')::integer legacy_derivative_sources,
    count(*) filter(where p.original_available)::integer original_preserved_sources,
    count(*) filter(where p.quality_status in ('needs_review','failed'))::integer invalid_sources,
    count(*) filter(where p.ingest_mode<>'legacy_reencoded_derivative' and (
      p.original_sha256 is null or p.original_size_bytes is null or p.original_mime_type is null or p.original_verified_at is null
    ))::integer unverified_original_sources
  from fs left join public.source_image_ingest_provenance_v2 p using(source_image_id)
)
select *,
  case when missing_provenance=0 and invalid_sources=0 and unverified_original_sources=0 then 'passed' else 'failed' end provenance_gate
from s;

revoke all on public.source_image_ingest_provenance_gate_v3 from public,anon,authenticated;
grant select on public.source_image_ingest_provenance_gate_v3 to service_role;

commit;
begin;

alter table public.source_images
  add column if not exists ingest_slot integer;

alter table public.source_images
  drop constraint if exists source_images_ingest_slot_positive;
alter table public.source_images
  add constraint source_images_ingest_slot_positive
  check (ingest_slot is null or ingest_slot > 0);

create unique index if not exists source_images_batch_ingest_slot_unique_v4
  on public.source_images(batch_id, ingest_slot)
  where batch_id is not null and ingest_slot is not null;

create or replace function public.source_image_ingest_slot_status_v4(
  p_batch_id uuid,
  p_ingest_slot integer
) returns table(
  source_image_id uuid,
  file_name text,
  storage_path text,
  ocr_status text,
  provenance_version text,
  ingest_mode text,
  original_storage_path text,
  ocr_derivative_storage_path text,
  quality_status text
)
language sql
stable
security definer
set search_path=pg_catalog,public
as $function$
  select s.id,s.file_name,s.storage_path,s.ocr_status,
         p.provenance_version,p.ingest_mode,p.original_storage_path,p.ocr_derivative_storage_path,p.quality_status
  from public.source_images s
  left join public.source_image_ingest_provenance_v2 p on p.source_image_id=s.id
  where s.batch_id=p_batch_id and s.ingest_slot=p_ingest_slot
  limit 1
$function$;

revoke all on function public.source_image_ingest_slot_status_v4(uuid,integer) from public,anon,authenticated;
grant execute on function public.source_image_ingest_slot_status_v4(uuid,integer) to service_role;

commit;
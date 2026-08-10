create or replace function public.enqueue_source_page_ocr_recovery_jobs_v1()
returns integer
language plpgsql
security definer
set search_path='pg_catalog','public'
as $$
declare v_count integer; v_expected integer; v_existing integer;
begin
  select count(*)::integer into v_expected from public.source_page_inventory_capture_v1;
  select count(*)::integer into v_existing
  from public.source_page_ocr_recovery_jobs_v1
  where recovery_version='page_ocr_recovery_v1_fresh_google';
  if v_existing = v_expected and v_expected > 0 then return 0; end if;

  insert into public.source_page_ocr_recovery_jobs_v1(
    page_identity_source_image_id, source_image_id, source_ocr_json_sha256,
    source_storage_etag, source_storage_size_bytes, old_block_count
  )
  select c.page_identity_source_image_id, c.inventory_source_image_id, c.source_ocr_json_sha256,
         s.storage_etag, s.storage_size_bytes, c.block_count
  from public.source_page_inventory_capture_v1 c
  join public.source_images s on s.id=c.inventory_source_image_id
  where coalesce(s.storage_path,'')<>'' and coalesce(s.storage_etag,'')<>'' and s.storage_size_bytes>0
    and s.width>0 and s.height>0 and c.block_count>0
  on conflict(page_identity_source_image_id, source_image_id, source_ocr_json_sha256, recovery_version) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end
$$;
revoke all on function public.enqueue_source_page_ocr_recovery_jobs_v1() from public,anon,authenticated;
grant execute on function public.enqueue_source_page_ocr_recovery_jobs_v1() to service_role;

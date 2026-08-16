create or replace function public.claim_source_page_inventory_region_ocr_rescue_v2(
  p_job_id uuid,
  p_lease_seconds integer default 420
)
returns setof public.source_page_inventory_region_ocr_recovery_v1
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_id uuid;
  v_token uuid := gen_random_uuid();
begin
  if p_job_id is null then return; end if;

  select id into v_id
  from public.source_page_inventory_region_ocr_recovery_v1
  where id = p_job_id
    and status = 'needs_review'
    and attempt_count = 1
    and error_message = 'region crop OCR returned insufficient text'
    and crop_spec_sha256 is not null
    and crop_image_sha256 is not null
    and google_response_sha256 is not null
    and google_text_sha256 is not null
    and crop_json is not null
    and evidence_json is not null
    and completed_at is not null
  for update skip locked;

  if v_id is null then return; end if;

  update public.source_page_inventory_region_ocr_recovery_v1
  set status = 'running',
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => greatest(300,least(600,coalesce(p_lease_seconds,420)))),
      attempt_count = attempt_count + 1,
      error_message = null,
      updated_at = now()
  where id = v_id;

  return query
  select * from public.source_page_inventory_region_ocr_recovery_v1 where id = v_id;
end
$function$;

revoke all on function public.claim_source_page_inventory_region_ocr_rescue_v2(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_source_page_inventory_region_ocr_rescue_v2(uuid, integer) to service_role;

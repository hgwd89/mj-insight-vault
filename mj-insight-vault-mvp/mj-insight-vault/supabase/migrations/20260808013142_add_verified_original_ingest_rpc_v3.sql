create or replace function public.record_source_image_ingest_provenance_v3(
  p_source_image_id uuid,
  p_original_storage_path text,
  p_original_sha256 text,
  p_original_size_bytes bigint,
  p_original_mime_type text,
  p_derivative_sha256 text,
  p_derivative_size_bytes bigint,
  p_derivative_mime_type text,
  p_transform_json jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare s public.source_images%rowtype; v_prefix text;
begin
  select * into s from public.source_images where id=p_source_image_id for update;
  if not found then raise exception 'ingest_v3_source_image_missing'; end if;
  v_prefix:=s.batch_id::text||'/original/';
  if coalesce(btrim(p_original_storage_path),'')='' or left(p_original_storage_path,length(v_prefix))<>v_prefix then raise exception 'ingest_v3_original_path_invalid'; end if;
  if p_original_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'ingest_v3_original_sha_invalid'; end if;
  if p_derivative_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'ingest_v3_derivative_sha_invalid'; end if;
  if p_original_size_bytes is null or p_original_size_bytes<=0 or p_derivative_size_bytes is null or p_derivative_size_bytes<=0 then raise exception 'ingest_v3_size_invalid'; end if;
  if coalesce(btrim(p_original_mime_type),'')='' or coalesce(btrim(p_derivative_mime_type),'')='' then raise exception 'ingest_v3_mime_invalid'; end if;
  if s.storage_path is distinct from regexp_replace(s.storage_path,'^/+','') then raise exception 'ingest_v3_derivative_path_invalid'; end if;

  insert into public.source_image_ingest_provenance_v2(
    source_image_id,provenance_version,ingest_mode,
    original_storage_path,original_sha256,original_size_bytes,original_mime_type,original_verified_at,
    ocr_derivative_storage_path,ocr_derivative_sha256,ocr_derivative_size_bytes,ocr_derivative_mime_type,
    transform_json,original_available,quality_status,updated_at
  ) values(
    s.id,'source_ingest_provenance_v3','original_and_ocr_derivative',
    p_original_storage_path,p_original_sha256,p_original_size_bytes,p_original_mime_type,now(),
    s.storage_path,p_derivative_sha256,p_derivative_size_bytes,p_derivative_mime_type,
    coalesce(p_transform_json,'{}'::jsonb),true,'passed',now()
  )
  on conflict(source_image_id) do update set
    provenance_version='source_ingest_provenance_v3',ingest_mode='original_and_ocr_derivative',
    original_storage_path=excluded.original_storage_path,original_sha256=excluded.original_sha256,
    original_size_bytes=excluded.original_size_bytes,original_mime_type=excluded.original_mime_type,original_verified_at=excluded.original_verified_at,
    ocr_derivative_storage_path=excluded.ocr_derivative_storage_path,ocr_derivative_sha256=excluded.ocr_derivative_sha256,
    ocr_derivative_size_bytes=excluded.ocr_derivative_size_bytes,ocr_derivative_mime_type=excluded.ocr_derivative_mime_type,
    transform_json=excluded.transform_json,original_available=true,quality_status='passed',updated_at=now();

  return jsonb_build_object('status','passed','source_image_id',s.id,'ingest_mode','original_and_ocr_derivative');
end
$function$;
revoke all on function public.record_source_image_ingest_provenance_v3(uuid,text,text,bigint,text,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_source_image_ingest_provenance_v3(uuid,text,text,bigint,text,text,bigint,text,jsonb) to service_role;

begin;

create or replace function public.record_source_image_ingest_provenance_v4(
  p_source_image_id uuid,
  p_original_storage_path text,
  p_original_sha256 text,
  p_original_size_bytes bigint,
  p_original_mime_type text,
  p_derivative_sha256 text,
  p_derivative_size_bytes bigint,
  p_derivative_mime_type text,
  p_transform_json jsonb
)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public'
as $function$
declare
  s public.source_images%rowtype;
  v_slot text;
  v_expected_original_prefix text;
  v_expected_derivative text;
  v_result jsonb;
begin
  select * into s from public.source_images where id=p_source_image_id for update;
  if not found then raise exception 'ingest_provenance_v4_source_missing'; end if;
  if s.batch_id is null or s.ingest_slot is null or s.ingest_slot<=0 then raise exception 'ingest_provenance_v4_batch_slot_required'; end if;
  if coalesce(p_original_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_derivative_sha256,'')!~'^[0-9a-f]{64}$' then raise exception 'ingest_provenance_v4_sha_invalid'; end if;
  if coalesce(p_original_size_bytes,0)<=0 or coalesce(p_derivative_size_bytes,0)<=0 then raise exception 'ingest_provenance_v4_size_invalid'; end if;
  if coalesce(p_original_mime_type,'')='' or coalesce(p_derivative_mime_type,'')<>'image/jpeg' then raise exception 'ingest_provenance_v4_mime_invalid'; end if;
  v_slot:=lpad(s.ingest_slot::text,2,'0');
  v_expected_original_prefix:=s.batch_id::text||'/original/'||v_slot||'_'||p_original_sha256||'.';
  if left(p_original_storage_path,char_length(v_expected_original_prefix))<>v_expected_original_prefix then raise exception 'ingest_provenance_v4_original_path_not_content_addressed'; end if;
  v_expected_derivative:=s.batch_id::text||'/ocr/'||v_slot||'_'||p_original_sha256||'_ocr-jpeg-v1.jpg';
  if s.storage_path is distinct from v_expected_derivative then raise exception 'ingest_provenance_v4_derivative_path_mismatch'; end if;
  if coalesce(s.file_sha256,'')~'^[0-9a-f]{64}$' and s.file_sha256 is distinct from p_derivative_sha256 then raise exception 'ingest_provenance_v4_derivative_sha_mismatch'; end if;
  if coalesce(p_transform_json->>'original_preserved','false')<>'true' or coalesce(p_transform_json->>'derivative_role','')<>'google_vision_ocr_input' or coalesce(p_transform_json->>'derivative_version','')<>'ocr-jpeg-v1' or coalesce(p_transform_json->>'derivative_format','')<>'image/jpeg' then raise exception 'ingest_provenance_v4_transform_contract_invalid'; end if;
  v_result:=public.record_source_image_ingest_provenance_v3(p_source_image_id,p_original_storage_path,p_original_sha256,p_original_size_bytes,p_original_mime_type,p_derivative_sha256,p_derivative_size_bytes,p_derivative_mime_type,p_transform_json);
  return v_result||jsonb_build_object('contract_version','source_ingest_v4_batch_slot_sha');
end
$function$;

revoke all on function public.record_source_image_ingest_provenance_v4(uuid,text,text,bigint,text,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_source_image_ingest_provenance_v4(uuid,text,text,bigint,text,text,bigint,text,jsonb) to service_role;
revoke execute on function public.record_source_image_ingest_provenance_v3(uuid,text,text,bigint,text,text,bigint,text,jsonb) from service_role;

commit;
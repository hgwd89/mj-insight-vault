begin;

alter table public.ocr_verification_source_binary_receipts_v8
  add column bucket_id text,
  add column storage_object_id uuid,
  add column storage_object_etag text,
  add column storage_object_updated_at timestamptz;

alter table public.ocr_verification_source_binary_receipts_v8
  alter column bucket_id set not null,
  alter column storage_object_id set not null,
  alter column storage_object_etag set not null,
  alter column storage_object_updated_at set not null;

create index if not exists ocr_verification_source_binary_receipts_v8_storage_object_idx
  on public.ocr_verification_source_binary_receipts_v8(storage_object_id);

create or replace function public.record_ocr_verification_source_binary_receipt_v9(p_job_id uuid,p_lease_token uuid,p_source_mode text,p_storage_path text,p_content_sha256 text,p_byte_size bigint)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','storage','extensions'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  s public.source_images%rowtype;
  p public.source_image_ingest_provenance_v2%rowtype;
  o storage.objects%rowtype;
  v_bucket text;
  v_etag text;
  v_size bigint;
  v_identity text;
begin
  select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_source_binary_v9_lease_invalid'; end if;
  if p_source_mode not in ('verified_original','ocr_derivative') or coalesce(p_content_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_storage_path,'')='' or coalesce(p_byte_size,0)<=0 then raise exception 'ocr_source_binary_v9_input_invalid'; end if;
  select * into s from public.source_images where id=j.evidence_source_image_id;
  if not found then raise exception 'ocr_source_binary_v9_source_missing'; end if;
  select * into p from public.source_image_ingest_provenance_v2 where source_image_id=s.id;

  select so.bucket_id into v_bucket
  from storage.objects so
  where so.name=s.storage_path
    and (coalesce(s.storage_etag,'')='' or so.metadata->>'eTag'=s.storage_etag)
    and (s.storage_size_bytes is null or nullif(so.metadata->>'size','')::bigint=s.storage_size_bytes)
  order by so.updated_at desc
  limit 1;
  if coalesce(v_bucket,'')='' then raise exception 'ocr_source_binary_v9_bucket_unresolved'; end if;

  select * into o from storage.objects where bucket_id=v_bucket and name=p_storage_path order by updated_at desc limit 1;
  if not found then raise exception 'ocr_source_binary_v9_storage_object_missing'; end if;
  v_etag:=coalesce(o.metadata->>'eTag','');
  v_size:=nullif(o.metadata->>'size','')::bigint;
  if v_etag='' or v_size is null or v_size<>p_byte_size then raise exception 'ocr_source_binary_v9_storage_metadata_mismatch'; end if;

  if p_source_mode='verified_original' then
    if p.source_image_id is null or p.quality_status<>'passed' or not p.original_available or p.original_verified_at is null or p.original_storage_path is distinct from p_storage_path or p.original_sha256 is distinct from p_content_sha256 or p.original_size_bytes is distinct from p_byte_size then raise exception 'ocr_source_binary_v9_original_identity_mismatch'; end if;
  else
    if s.storage_path is distinct from p_storage_path then raise exception 'ocr_source_binary_v9_derivative_path_mismatch'; end if;
    if s.storage_size_bytes is not null and s.storage_size_bytes is distinct from p_byte_size then raise exception 'ocr_source_binary_v9_derivative_size_mismatch'; end if;
    if coalesce(s.file_sha256,'')~'^[0-9a-f]{64}$' and s.file_sha256 is distinct from p_content_sha256 then raise exception 'ocr_source_binary_v9_derivative_file_sha_mismatch'; end if;
    if p.source_image_id is not null and coalesce(p.ocr_derivative_sha256,'')~'^[0-9a-f]{64}$' and p.ocr_derivative_sha256 is distinct from p_content_sha256 then raise exception 'ocr_source_binary_v9_derivative_provenance_sha_mismatch'; end if;
    if coalesce(s.file_sha256,'')!~'^[0-9a-f]{64}$' and (p.source_image_id is null or coalesce(p.ocr_derivative_sha256,'')!~'^[0-9a-f]{64}$') and (coalesce(s.storage_etag,'')='' or s.storage_size_bytes is null) then raise exception 'ocr_source_binary_v9_derivative_identity_insufficient'; end if;
  end if;

  v_identity:=encode(extensions.digest(convert_to(p_source_mode||'|'||v_bucket||'|'||o.id::text||'|'||p_storage_path||'|'||v_etag||'|'||p_byte_size::text||'|'||p_content_sha256||'|'||o.updated_at::text,'UTF8'),'sha256'),'hex');
  insert into public.ocr_verification_source_binary_receipts_v8(job_id,source_image_id,source_mode,storage_path,storage_etag,byte_size,content_sha256,identity_fingerprint,bucket_id,storage_object_id,storage_object_etag,storage_object_updated_at,updated_at)
  values(j.id,s.id,p_source_mode,p_storage_path,v_etag,p_byte_size,p_content_sha256,v_identity,v_bucket,o.id,v_etag,o.updated_at,now())
  on conflict(job_id) do update set source_image_id=excluded.source_image_id,source_mode=excluded.source_mode,storage_path=excluded.storage_path,storage_etag=excluded.storage_etag,byte_size=excluded.byte_size,content_sha256=excluded.content_sha256,identity_fingerprint=excluded.identity_fingerprint,bucket_id=excluded.bucket_id,storage_object_id=excluded.storage_object_id,storage_object_etag=excluded.storage_object_etag,storage_object_updated_at=excluded.storage_object_updated_at,updated_at=now();
  return jsonb_build_object('status','recorded','identity_fingerprint',v_identity,'source_mode',p_source_mode,'content_sha256',p_content_sha256,'byte_size',p_byte_size,'storage_object_id',o.id,'storage_object_etag',v_etag);
end
$function$;

create or replace view public.current_ocr_source_binary_receipts_v9
with (security_invoker=true)
as
select r.*
from public.ocr_verification_source_binary_receipts_v8 r
join storage.objects o on o.id=r.storage_object_id and o.bucket_id=r.bucket_id and o.name=r.storage_path
where coalesce(o.metadata->>'eTag','')=r.storage_object_etag
  and nullif(o.metadata->>'size','')::bigint=r.byte_size
  and o.updated_at=r.storage_object_updated_at;

revoke all on public.current_ocr_source_binary_receipts_v9 from public,anon,authenticated;
grant select on public.current_ocr_source_binary_receipts_v9 to service_role;

create or replace function public.replace_ocr_crop_results_v9(p_job_id uuid,p_lease_token uuid,p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public'
as $function$
begin
  if not exists(select 1 from public.current_ocr_source_binary_receipts_v9 where job_id=p_job_id) then raise exception 'ocr_crop_v9_current_source_binary_receipt_required'; end if;
  return public.replace_ocr_crop_results_v8(p_job_id,p_lease_token,p_rows);
end
$function$;

revoke all on function public.record_ocr_verification_source_binary_receipt_v9(uuid,uuid,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.record_ocr_verification_source_binary_receipt_v9(uuid,uuid,text,text,text,bigint) to service_role;
revoke all on function public.replace_ocr_crop_results_v9(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.replace_ocr_crop_results_v9(uuid,uuid,jsonb) to service_role;
revoke execute on function public.record_ocr_verification_source_binary_receipt_v8(uuid,uuid,text,text,text,bigint) from service_role;
revoke execute on function public.replace_ocr_crop_results_v8(uuid,uuid,jsonb) from service_role;

commit;
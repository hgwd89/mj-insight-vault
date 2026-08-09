begin;

create table if not exists public.ocr_verification_source_binary_receipts_v8(
  job_id uuid primary key references public.ocr_verification_page_jobs_v2(id) on delete cascade,
  source_image_id uuid not null references public.source_images(id),
  source_mode text not null check(source_mode in ('verified_original','ocr_derivative')),
  storage_path text not null,
  storage_etag text,
  byte_size bigint not null check(byte_size>0),
  content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
  identity_fingerprint text not null check(identity_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ocr_verification_source_binary_receipts_v8 enable row level security;
revoke all on public.ocr_verification_source_binary_receipts_v8 from public,anon,authenticated,service_role;
grant select on public.ocr_verification_source_binary_receipts_v8 to service_role;

create index if not exists ocr_verification_source_binary_receipts_v8_source_idx on public.ocr_verification_source_binary_receipts_v8(source_image_id);

create or replace function public.record_ocr_verification_source_binary_receipt_v8(p_job_id uuid,p_lease_token uuid,p_source_mode text,p_storage_path text,p_content_sha256 text,p_byte_size bigint)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  s public.source_images%rowtype;
  p public.source_image_ingest_provenance_v2%rowtype;
  v_etag text;
  v_identity text;
begin
  select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_source_binary_v8_lease_invalid'; end if;
  if p_source_mode not in ('verified_original','ocr_derivative') or coalesce(p_content_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_storage_path,'')='' or coalesce(p_byte_size,0)<=0 then raise exception 'ocr_source_binary_v8_input_invalid'; end if;
  select * into s from public.source_images where id=j.evidence_source_image_id;
  if not found then raise exception 'ocr_source_binary_v8_source_missing'; end if;
  select * into p from public.source_image_ingest_provenance_v2 where source_image_id=s.id;

  if p_source_mode='verified_original' then
    if p.source_image_id is null or p.quality_status<>'passed' or not p.original_available or p.original_verified_at is null or p.original_storage_path is distinct from p_storage_path or p.original_sha256 is distinct from p_content_sha256 or p.original_size_bytes is distinct from p_byte_size then
      raise exception 'ocr_source_binary_v8_original_identity_mismatch';
    end if;
    v_etag:=null;
    v_identity:=encode(extensions.digest(convert_to('verified_original|'||p_storage_path||'|'||p_content_sha256||'|'||p_byte_size::text,'UTF8'),'sha256'),'hex');
  else
    if s.storage_path is distinct from p_storage_path then raise exception 'ocr_source_binary_v8_derivative_path_mismatch'; end if;
    if s.storage_size_bytes is not null and s.storage_size_bytes is distinct from p_byte_size then raise exception 'ocr_source_binary_v8_derivative_size_mismatch'; end if;
    if coalesce(s.file_sha256,'')~'^[0-9a-f]{64}$' and s.file_sha256 is distinct from p_content_sha256 then raise exception 'ocr_source_binary_v8_derivative_file_sha_mismatch'; end if;
    if p.source_image_id is not null and coalesce(p.ocr_derivative_sha256,'')~'^[0-9a-f]{64}$' and p.ocr_derivative_sha256 is distinct from p_content_sha256 then raise exception 'ocr_source_binary_v8_derivative_provenance_sha_mismatch'; end if;
    if coalesce(s.file_sha256,'')!~'^[0-9a-f]{64}$' and (p.source_image_id is null or coalesce(p.ocr_derivative_sha256,'')!~'^[0-9a-f]{64}$') and (coalesce(s.storage_etag,'')='' or s.storage_size_bytes is null) then
      raise exception 'ocr_source_binary_v8_derivative_identity_insufficient';
    end if;
    v_etag:=s.storage_etag;
    v_identity:=encode(extensions.digest(convert_to('ocr_derivative|'||p_storage_path||'|'||coalesce(s.storage_etag,'')||'|'||p_byte_size::text||'|'||p_content_sha256,'UTF8'),'sha256'),'hex');
  end if;

  insert into public.ocr_verification_source_binary_receipts_v8(job_id,source_image_id,source_mode,storage_path,storage_etag,byte_size,content_sha256,identity_fingerprint,updated_at)
  values(j.id,s.id,p_source_mode,p_storage_path,v_etag,p_byte_size,p_content_sha256,v_identity,now())
  on conflict(job_id) do update set source_image_id=excluded.source_image_id,source_mode=excluded.source_mode,storage_path=excluded.storage_path,storage_etag=excluded.storage_etag,byte_size=excluded.byte_size,content_sha256=excluded.content_sha256,identity_fingerprint=excluded.identity_fingerprint,updated_at=now();
  return jsonb_build_object('status','recorded','identity_fingerprint',v_identity,'source_mode',p_source_mode,'content_sha256',p_content_sha256,'byte_size',p_byte_size);
end
$function$;

create or replace function public.replace_ocr_crop_results_v8(p_job_id uuid,p_lease_token uuid,p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public'
as $function$
declare
  r public.ocr_verification_source_binary_receipts_v8%rowtype;
  v_mode text;
  v_sha text;
  v_count integer;
begin
  select * into r from public.ocr_verification_source_binary_receipts_v8 where job_id=p_job_id;
  if not found then raise exception 'ocr_crop_v8_source_binary_receipt_required'; end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<1 then raise exception 'ocr_crop_v8_rows_required'; end if;
  select count(distinct x.source_mode)::integer,max(x.source_mode),count(distinct x.source_image_sha256)::integer,max(x.source_image_sha256) into v_count,v_mode,v_count,v_sha
  from jsonb_to_recordset(p_rows) x(source_mode text,source_image_sha256 text);
  if exists(select 1 from jsonb_to_recordset(p_rows) x(source_mode text,source_image_sha256 text) where x.source_mode is distinct from r.source_mode or x.source_image_sha256 is distinct from r.content_sha256) then
    raise exception 'ocr_crop_v8_source_binary_binding_mismatch';
  end if;
  return public.replace_ocr_crop_results_v6(p_job_id,p_lease_token,p_rows);
end
$function$;

revoke all on function public.record_ocr_verification_source_binary_receipt_v8(uuid,uuid,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.record_ocr_verification_source_binary_receipt_v8(uuid,uuid,text,text,text,bigint) to service_role;
revoke all on function public.replace_ocr_crop_results_v8(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.replace_ocr_crop_results_v8(uuid,uuid,jsonb) to service_role;
revoke execute on function public.replace_ocr_crop_results_v6(uuid,uuid,jsonb) from service_role;

commit;
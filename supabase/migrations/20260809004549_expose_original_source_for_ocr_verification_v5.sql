begin;

create or replace function public.get_ocr_verification_source_provenance_v5(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  p public.source_image_ingest_provenance_v2%rowtype;
begin
  select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'ocr_source_provenance_v5_lease_invalid';
  end if;
  select * into p from public.source_image_ingest_provenance_v2 where source_image_id=j.evidence_source_image_id;
  if not found then
    return jsonb_build_object('use_original',false,'reason','provenance_missing');
  end if;
  if p.quality_status='passed' and p.original_available and p.original_verified_at is not null and coalesce(p.original_storage_path,'')<>'' and coalesce(p.original_sha256,'')~'^[0-9a-f]{64}$' then
    return jsonb_build_object('use_original',true,'original_storage_path',p.original_storage_path,'original_sha256',p.original_sha256,'original_size_bytes',p.original_size_bytes,'original_mime_type',p.original_mime_type,'ingest_mode',p.ingest_mode,'quality_status',p.quality_status,'original_verified_at',p.original_verified_at);
  end if;
  return jsonb_build_object('use_original',false,'reason','verified_original_unavailable','ingest_mode',p.ingest_mode,'quality_status',p.quality_status);
end
$function$;

revoke all on function public.get_ocr_verification_source_provenance_v5(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_ocr_verification_source_provenance_v5(uuid,uuid) to service_role;

commit;
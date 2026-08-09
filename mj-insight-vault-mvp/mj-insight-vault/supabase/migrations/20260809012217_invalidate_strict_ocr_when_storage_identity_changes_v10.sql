begin;

create or replace view public.current_ocr_source_binary_receipts_v9
with (security_invoker=true)
as
select r.*
from public.ocr_verification_source_binary_receipts_v8 r
join storage.objects o on o.id=r.storage_object_id and o.bucket_id=r.bucket_id and o.name=r.storage_path
where coalesce(o.metadata->>'eTag','')=r.storage_object_etag
  and nullif(o.metadata->>'size','')::bigint=r.byte_size;

create or replace function public.invalidate_strict_ocr_on_storage_identity_change_v10()
returns trigger
language plpgsql
security definer
set search_path='pg_catalog','public','storage'
as $function$
declare
  v_id uuid;
  v_bucket text;
  v_name text;
  v_etag text;
  v_size bigint;
begin
  v_id:=coalesce(new.id,old.id);
  if tg_op='DELETE' then
    update public.ocr_verification_page_jobs_v2 j
    set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,
        error_message='source storage object deleted after OCR verification',updated_at=now()
    where exists(select 1 from public.ocr_verification_source_binary_receipts_v8 r where r.job_id=j.id and r.storage_object_id=v_id)
      and j.status<>'needs_review';
    return old;
  end if;

  v_bucket:=new.bucket_id;
  v_name:=new.name;
  v_etag:=coalesce(new.metadata->>'eTag','');
  v_size:=nullif(new.metadata->>'size','')::bigint;

  update public.ocr_verification_page_jobs_v2 j
  set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,
      error_message='source storage object identity changed after OCR verification',updated_at=now()
  where exists(
    select 1 from public.ocr_verification_source_binary_receipts_v8 r
    where r.job_id=j.id and r.storage_object_id=v_id
      and (r.bucket_id is distinct from v_bucket or r.storage_path is distinct from v_name or r.storage_object_etag is distinct from v_etag or r.byte_size is distinct from v_size)
  ) and j.status<>'needs_review';
  return new;
end
$function$;

drop trigger if exists invalidate_strict_ocr_on_storage_identity_change_v10 on storage.objects;
create trigger invalidate_strict_ocr_on_storage_identity_change_v10
after update of bucket_id,name,metadata or delete on storage.objects
for each row execute function public.invalidate_strict_ocr_on_storage_identity_change_v10();

revoke all on function public.invalidate_strict_ocr_on_storage_identity_change_v10() from public,anon,authenticated,service_role;

commit;
create or replace function public.claim_ocr_consensus_canary_v16(p_lease_seconds integer default 360)
returns table(id uuid,source_job_id uuid,article_count integer,is_canary boolean,lease_token uuid)
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_id uuid;
  v_token uuid:=gen_random_uuid();
begin
  if p_lease_seconds < 60 or p_lease_seconds > 900 then raise exception 'ocr_consensus_v16_bad_lease'; end if;
  select j.id into v_id
  from public.ocr_consensus_jobs_v11 j
  join public.ocr_verification_page_jobs_v2 src on src.id=j.source_job_id
  where j.status='queued' and j.is_canary is true and j.lease_token is null
    and exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=src.freeze_receipt_id)
    and (select count(*) from public.ocr_verification_crop_ocr_v4 c where c.job_id=j.source_job_id and c.crop_version='article_geometry_mask_composite_v3')=j.article_count
  order by j.created_at,j.id
  for update of j skip locked
  limit 1;
  if v_id is null then return; end if;
  update public.ocr_consensus_jobs_v11 j
     set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
   where j.id=v_id;
  return query select j.id,j.source_job_id,j.article_count,j.is_canary,j.lease_token from public.ocr_consensus_jobs_v11 j where j.id=v_id;
end
$function$;

revoke all on function public.claim_ocr_consensus_canary_v16(integer) from public,anon,authenticated;
grant execute on function public.claim_ocr_consensus_canary_v16(integer) to postgres,service_role;

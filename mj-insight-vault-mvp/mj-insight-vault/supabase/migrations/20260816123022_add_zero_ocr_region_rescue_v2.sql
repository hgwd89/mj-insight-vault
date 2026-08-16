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

create or replace function public.enqueue_source_page_inventory_region_ocr_recovery_v2(p_inventory_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_freeze uuid;
  v_id uuid;
  v_passes integer;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_inventory_job_id;
  if not found or j.inventory_version<>'page_article_inventory_v4_recovered_ocr' or j.status<>'needs_review' then
    raise exception 'region_ocr_recovery_wrong_inventory_state';
  end if;
  if coalesce(j.error_message,'') not like 'Two independent visual passes support an article region with zero fresh OCR blocks%'
     and coalesce(j.error_message,'') not like 'Two independent visual passes support an article region with no usable fresh OCR anchor blocks%'
  then
    raise exception 'region_ocr_recovery_zero_block_review_required';
  end if;
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null or j.freeze_receipt_id is distinct from v_freeze then
    raise exception 'region_ocr_recovery_not_current_freeze';
  end if;
  select count(distinct pass_kind) into v_passes
  from public.source_page_inventory_visual_region_evidence_v6
  where job_id=j.id and dropped_from_partition=true and pass_kind in ('mapper','critic','adjudicator');
  if v_passes<2 then
    raise exception 'region_ocr_recovery_independent_visual_support_required';
  end if;
  insert into public.source_page_inventory_region_ocr_recovery_v1(inventory_job_id,source_image_id,status)
  values(j.id,j.inventory_source_image_id,'queued')
  on conflict(inventory_job_id) do update
  set status=case when source_page_inventory_region_ocr_recovery_v1.status='completed' then 'completed' else 'queued' end,
      error_message=null,
      updated_at=now()
  returning id into v_id;
  return v_id;
end
$function$;

revoke all on function public.enqueue_source_page_inventory_region_ocr_recovery_v2(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_source_page_inventory_region_ocr_recovery_v2(uuid) to service_role;

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

alter table public.source_page_inventory_visual_exclusions_v1
  drop constraint if exists source_page_inventory_visual_exclusions_v1_exclusion_kind_check;
alter table public.source_page_inventory_visual_exclusions_v1
  add constraint source_page_inventory_visual_exclusions_v1_exclusion_kind_check
  check (exclusion_kind = any (array[
    'zero_ocr_false_positive'::text,
    'navigation_teaser_to_non_article'::text,
    'advertisement_event_promo_to_non_article'::text,
    'recurring_pos_table_to_non_article'::text,
    'region_ocr_promotional_false_positive'::text
  ]));

create or replace function public.apply_region_ocr_promotional_false_positive_v1(p_job_id uuid, p_headline_hint text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_freeze uuid;
  v_norm text;
  v_rows jsonb;
  v_count integer;
  v_adjudicator integer;
  v_region public.source_page_inventory_region_ocr_recovery_v1%rowtype;
  v_receipt uuid;
  v_text text;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.inventory_version<>'page_article_inventory_v4_recovered_ocr' or j.status<>'needs_review' then
    raise exception 'region_ocr_promo_exclusion_wrong_job_state';
  end if;
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null or j.freeze_receipt_id is distinct from v_freeze then raise exception 'region_ocr_promo_exclusion_not_current_freeze'; end if;
  if exists(select 1 from public.source_region_materialization_receipts_v6 where inventory_job_id=j.id)
     or exists(select 1 from public.source_page_article_inventory_mappings_v2 where job_id=j.id)
     or exists(select 1 from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id) then
    raise exception 'region_ocr_promo_exclusion_downstream_state_exists';
  end if;

  select * into v_region from public.source_page_inventory_region_ocr_recovery_v1 where inventory_job_id=j.id;
  if not found or v_region.status<>'completed' or coalesce(v_region.recovered_block_count,0)<1
     or coalesce(length(btrim(v_region.recovered_text)),0)<30
     or v_region.google_response_sha256 is null or v_region.google_text_sha256 is null
     or v_region.crop_image_sha256 is null or v_region.crop_spec_sha256 is null then
    raise exception 'region_ocr_promo_exclusion_positive_ocr_receipt_required';
  end if;
  v_text:=coalesce(v_region.recovered_text,'');
  if v_text !~ '出版'
     or (v_text !~ '〒' and v_text !~ '東京都')
     or (v_text !~* 'TEL' and v_text !~ '[0-9]{2,4}\([0-9]{2,4}\)[0-9]{3,4}' and v_text !~* 'www\.') then
    raise exception 'region_ocr_promo_exclusion_publisher_contact_signals_required';
  end if;

  v_norm:=regexp_replace(lower(coalesce(p_headline_hint,'')),'[[:space:][:punct:]]','','g');
  if length(v_norm)<4 then raise exception 'region_ocr_promo_exclusion_headline_required'; end if;
  select jsonb_agg(to_jsonb(e) order by e.pass_kind,e.article_seq),count(*)::integer
    into v_rows,v_count
  from public.source_page_inventory_visual_region_evidence_v6 e
  where e.job_id=j.id and e.pass_kind in ('mapper','critic') and e.dropped_from_partition=true
    and regexp_replace(lower(e.headline_hint),'[[:space:][:punct:]]','','g')=v_norm;
  if v_count<>2 then raise exception 'region_ocr_promo_exclusion_two_raw_support_rows_required'; end if;
  select count(*)::integer into v_adjudicator
  from public.source_page_inventory_visual_region_evidence_v6 e
  where e.job_id=j.id and e.pass_kind='adjudicator'
    and regexp_replace(lower(e.headline_hint),'[[:space:][:punct:]]','','g')=v_norm;
  if v_adjudicator<>0 then raise exception 'region_ocr_promo_exclusion_adjudicator_supports_region'; end if;
  if not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id and pass_kind='adjudicator' and model='gpt-5.6-sol') then
    raise exception 'region_ocr_promo_exclusion_sol_adjudicator_receipt_required';
  end if;

  insert into public.source_page_inventory_visual_exclusions_v1(job_id,exclusion_kind,evidence_json,reason)
  values(j.id,'region_ocr_promotional_false_positive',jsonb_build_object(
    'headline_hint',p_headline_hint,
    'raw_region_evidence',v_rows,
    'region_ocr_recovery',to_jsonb(v_region),
    'deterministic_signals',jsonb_build_array('出版','postal_or_tokyo_address','telephone_or_web_contact'),
    'adjudicator_matching_regions',v_adjudicator
  ),coalesce(nullif(btrim(p_reason),''),'publisher/contact promotional panel excluded after positive region OCR'))
  returning id into v_receipt;

  delete from public.source_page_inventory_visual_region_evidence_v6 e
  where e.job_id=j.id and e.pass_kind in ('mapper','critic') and e.dropped_from_partition=true
    and regexp_replace(lower(e.headline_hint),'[[:space:][:punct:]]','','g')=v_norm;

  update public.source_page_article_inventory_jobs_v1
     set status='queued',lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now()
   where id=j.id;

  return jsonb_build_object('status','queued','job_id',j.id,'receipt_id',v_receipt,'archived_rows',v_count,'headline_hint',p_headline_hint);
end
$function$;

revoke all on function public.apply_region_ocr_promotional_false_positive_v1(uuid,text,text) from public,anon,authenticated;
grant execute on function public.apply_region_ocr_promotional_false_positive_v1(uuid,text,text) to service_role;

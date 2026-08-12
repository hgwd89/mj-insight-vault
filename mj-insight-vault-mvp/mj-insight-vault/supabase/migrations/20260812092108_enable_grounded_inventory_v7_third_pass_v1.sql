create or replace function public.enable_grounded_inventory_v7_third_pass_v1()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  v_enabled boolean;
  v_freeze uuid;
  v_pages integer;
  v_expected integer;
  v_sealed_fp text;
  v_current_fp text;
  v_current_jobs integer;
  v_total_jobs integer;
  v_third_jobs integer;
begin
  select enabled, freeze_receipt_id, recovery_completed_pages, recovery_set_fingerprint
    into v_enabled, v_freeze, v_pages, v_sealed_fp
  from public.inventory_v3_execution_control_v1
  where singleton=true
  for update;

  if not coalesce(v_enabled,false) or v_freeze is null then
    raise exception 'inventory_v7_third_pass_execution_not_enabled';
  end if;

  if not exists(
    select 1 from public.formal_corpus_freeze_gate_v2
    where freeze_gate_v2='passed' and freeze_receipt_id=v_freeze
  ) then
    raise exception 'inventory_v7_third_pass_freeze_not_current';
  end if;

  select expected_pages into v_expected
  from public.source_page_ocr_recovery_gate_v1
  where recovery_gate='passed';
  if v_expected is null or v_pages<>v_expected then
    raise exception 'inventory_v7_third_pass_page_recovery_not_passed';
  end if;

  select count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(
           page_identity_source_image_id::text||':'||coalesce(source_binary_sha256,'')||':'||coalesce(fresh_google_response_sha256,'')||':'||coalesce(fresh_google_text_sha256,'')||':'||coalesce(fresh_block_count::text,''),
           '|' order by page_identity_source_image_id::text),''),'UTF8'),'sha256'),'hex')
    into v_current_jobs,v_current_fp
  from public.source_page_current_ocr_recovery_jobs_v2
  where status='completed';

  if v_current_jobs<>v_expected
     or exists(select 1 from public.source_page_current_ocr_recovery_jobs_v2 where status<>'completed')
     or coalesce(v_current_fp,'')=''
     or v_current_fp is distinct from v_sealed_fp then
    update public.inventory_v3_execution_control_v1
       set enabled=false,
           grounded_third_pass_enabled=false,
           reason='current page recovery state or receipt fingerprint drifted before grounded third pass',
           updated_at=now()
     where singleton=true;
    raise exception 'inventory_v7_third_pass_recovery_fingerprint_drift';
  end if;

  select count(*)::integer into v_total_jobs
  from public.source_page_article_inventory_jobs_v1 j
  where j.inventory_version='page_article_inventory_v4_recovered_ocr'
    and j.freeze_receipt_id=v_freeze;
  if v_total_jobs<>v_expected then
    raise exception 'inventory_v7_third_pass_job_count_mismatch';
  end if;

  if exists(
    select 1 from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.freeze_receipt_id=v_freeze
      and j.status='running'
  ) then
    raise exception 'inventory_v7_third_pass_running_jobs_present';
  end if;

  if exists(
    select 1 from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.freeze_receipt_id=v_freeze
      and j.status='queued'
      and not j.requires_third_pass
  ) then
    raise exception 'inventory_v7_third_pass_first_two_pass_work_remaining';
  end if;

  select count(*)::integer into v_third_jobs
  from public.source_page_article_inventory_jobs_v1 j
  where j.inventory_version='page_article_inventory_v4_recovered_ocr'
    and j.freeze_receipt_id=v_freeze
    and j.status='queued'
    and j.requires_third_pass;

  if v_third_jobs<1 then
    raise exception 'inventory_v7_third_pass_no_jobs';
  end if;

  if exists(
    select 1
    from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.freeze_receipt_id=v_freeze
      and j.status='queued'
      and j.requires_third_pass
      and (
        not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id and p.pass_kind='mapper')
        or not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id and p.pass_kind='critic')
        or not exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=j.id and e.pass_kind='mapper')
        or not exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=j.id and e.pass_kind='critic')
        or exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id=j.id and e.pass_kind='adjudicator')
        or exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 c where c.job_id=j.id)
        or exists(select 1 from public.source_region_materialization_receipts_v6 m where m.inventory_job_id=j.id)
      )
  ) then
    raise exception 'inventory_v7_third_pass_job_evidence_contract_failed';
  end if;

  update public.inventory_v3_execution_control_v1
     set grounded_third_pass_enabled=true,
         reason='grounded V7 third pass enabled after complete mapper/critic scan',
         updated_at=now()
   where singleton=true;

  return jsonb_build_object(
    'enabled',true,
    'freeze_receipt_id',v_freeze,
    'expected_pages',v_expected,
    'third_pass_jobs',v_third_jobs,
    'recovery_set_fingerprint',v_current_fp
  );
end
$function$;

revoke all on function public.enable_grounded_inventory_v7_third_pass_v1() from public;
revoke all on function public.enable_grounded_inventory_v7_third_pass_v1() from anon;
revoke all on function public.enable_grounded_inventory_v7_third_pass_v1() from authenticated;
grant execute on function public.enable_grounded_inventory_v7_third_pass_v1() to service_role;

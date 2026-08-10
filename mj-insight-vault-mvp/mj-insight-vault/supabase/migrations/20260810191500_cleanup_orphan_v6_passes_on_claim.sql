-- Grounded V6 persists the blind pass and raw visual-region evidence in two DB calls.
-- If runtime/network failure occurs between those calls, the pass is not authoritative.
-- Clean only such orphan passes on the next claim before retrying the page.

create or replace function public.claim_source_page_article_inventory_job_v3(
  p_job_id uuid default null,
  p_lease_seconds integer default 240
)
returns setof public.source_page_article_inventory_jobs_v1
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_id uuid;
  v_status text;
  v_token uuid:=gen_random_uuid();
  v_enabled boolean;
  v_freeze uuid;
  v_pages integer;
  v_lease integer;
  v_orphan_passes text[];
begin
  select enabled,freeze_receipt_id,recovery_completed_pages
    into v_enabled,v_freeze,v_pages
  from public.inventory_v3_execution_control_v1
  where singleton=true;

  if not coalesce(v_enabled,false) or v_freeze is null or v_pages<>531 then return; end if;

  if (select count(*) from public.source_page_ocr_recovery_jobs_v1 where status='completed')<>531
     or exists(select 1 from public.source_page_ocr_recovery_jobs_v1 where status<>'completed') then
    update public.inventory_v3_execution_control_v1
       set enabled=false,reason='page recovery state drifted after execution seal',updated_at=now()
     where singleton=true;
    return;
  end if;

  if p_job_id is null then
    select j.id,j.status into v_id,v_status
    from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.freeze_receipt_id=v_freeze
      and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
      and j.attempt_count<4
    order by
      (select count(*) from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id) desc,
      j.requires_third_pass asc,
      j.existing_article_count asc,
      j.block_count asc,
      j.created_at,
      j.id
    for update skip locked
    limit 1;
  else
    select j.id,j.status into v_id,v_status
    from public.source_page_article_inventory_jobs_v1 j
    where j.id=p_job_id
      and j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.freeze_receipt_id=v_freeze
      and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
      and j.attempt_count<4
    for update skip locked;
  end if;

  if v_id is null then return; end if;

  select array_agg(p.pass_kind order by p.pass_kind)
    into v_orphan_passes
  from public.source_page_article_inventory_pass_runs_v1 p
  where p.job_id=v_id
    and p.pass_kind in ('mapper','critic','adjudicator')
    and not exists (
      select 1 from public.source_page_inventory_visual_region_evidence_v6 e
      where e.job_id=p.job_id and e.pass_kind=p.pass_kind
    );

  if coalesce(array_length(v_orphan_passes,1),0)>0 then
    delete from public.source_page_article_inventory_mappings_v2 where job_id=v_id;
    delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=v_id;
    delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=v_id;
    delete from public.source_page_inventory_visual_consensus_receipts_v4 where job_id=v_id;
    delete from public.source_page_inventory_visual_group_evidence_v4 where job_id=v_id;
    delete from public.source_page_article_inventory_groups_v1
      where job_id=v_id and pass_kind=any(v_orphan_passes);
    delete from public.source_page_article_inventory_pass_runs_v1
      where job_id=v_id and pass_kind=any(v_orphan_passes);
  end if;

  v_lease:=420;
  update public.source_page_article_inventory_jobs_v1
     set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>v_lease),
         attempt_count=attempt_count+case when v_status='running' then 1 else 0 end,
         error_message=null,updated_at=now()
   where id=v_id;

  return query select * from public.source_page_article_inventory_jobs_v1 where id=v_id;
end
$function$;

revoke all on function public.claim_source_page_article_inventory_job_v3(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_source_page_article_inventory_job_v3(uuid,integer) to service_role;

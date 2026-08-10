-- Keep current V6 runtime away from third-pass jobs until the Grounded V7
-- adjudicator is deployed. Preserve valid mapper/critic evidence while allowing
-- review jobs caused by raw-region parser jitter to resume under V7.

alter table public.inventory_v3_execution_control_v1
  add column if not exists grounded_third_pass_enabled boolean not null default false;

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
  v_allow_third boolean;
  v_lease integer;
  v_orphan_passes text[];
begin
  select enabled,freeze_receipt_id,recovery_completed_pages,grounded_third_pass_enabled
    into v_enabled,v_freeze,v_pages,v_allow_third
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
      and (coalesce(v_allow_third,false) or not j.requires_third_pass)
      and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
      and j.attempt_count<4
    order by
      (select count(*) from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id) desc,
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
      and (coalesce(v_allow_third,false) or not j.requires_third_pass)
      and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
      and j.attempt_count<4
    for update skip locked;
  end if;

  if v_id is null then return; end if;

  -- Grounded raw evidence is part of the pass receipt. A pass row without the
  -- matching evidence means execution stopped between the two writes. Remove
  -- only that orphan and downstream artifacts derived from it before retrying.
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

create or replace function public.resume_grounded_inventory_v7_v1(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_passes integer;
  v_evidence_passes integer;
begin
  select * into j
  from public.source_page_article_inventory_jobs_v1
  where id=p_job_id
  for update;

  if not found then raise exception 'grounded_v7_resume_job_missing'; end if;
  if j.inventory_version<>'page_article_inventory_v4_recovered_ocr' then raise exception 'grounded_v7_resume_wrong_version'; end if;
  if j.status<>'needs_review' then raise exception 'grounded_v7_resume_status_not_review'; end if;
  if exists(select 1 from public.source_region_materialization_receipts_v6 where inventory_job_id=j.id) then
    raise exception 'grounded_v7_resume_already_materialized';
  end if;
  if exists(select 1 from public.source_page_article_inventory_mappings_v2 where job_id=j.id) then
    raise exception 'grounded_v7_resume_mapping_exists';
  end if;

  select count(*) into v_passes
  from public.source_page_article_inventory_pass_runs_v1
  where job_id=j.id and pass_kind in ('mapper','critic','adjudicator');

  select count(distinct pass_kind) into v_evidence_passes
  from public.source_page_inventory_visual_region_evidence_v6
  where job_id=j.id and pass_kind in ('mapper','critic','adjudicator');

  if v_passes<1 or v_evidence_passes<1 then
    raise exception 'grounded_v7_resume_no_grounded_evidence';
  end if;

  update public.source_page_article_inventory_jobs_v1
     set status='queued',lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now()
   where id=j.id;

  return jsonb_build_object('status','queued','job_id',j.id,'preserved_passes',v_passes,'grounded_evidence_passes',v_evidence_passes);
end
$function$;

revoke all on function public.claim_source_page_article_inventory_job_v3(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_source_page_article_inventory_job_v3(uuid,integer) to service_role;
revoke all on function public.resume_grounded_inventory_v7_v1(uuid) from public,anon,authenticated;
grant execute on function public.resume_grounded_inventory_v7_v1(uuid) to service_role;

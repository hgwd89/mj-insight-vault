begin;

-- Nano-safe runtime binding for exactly one authoritative two-job OCR canary cohort.
-- This restores autonomous canary progress without reopening the 538-page rollout or downstream jobs.
create table if not exists public.ocr_consensus_canary_runtime_v32 (
  singleton boolean primary key default true check (singleton is true),
  cohort_id uuid not null references public.ocr_consensus_canary_cohorts_v26(id) on delete restrict,
  job_id_1 uuid not null references public.ocr_consensus_jobs_v11(id) on delete restrict,
  job_id_2 uuid not null references public.ocr_consensus_jobs_v11(id) on delete restrict,
  active boolean not null default true,
  activated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  constraint ocr_consensus_canary_runtime_v32_job_order check (job_id_1::text < job_id_2::text)
);

alter table public.ocr_consensus_canary_runtime_v32 enable row level security;
revoke all on table public.ocr_consensus_canary_runtime_v32 from public, anon, authenticated;
grant select, insert, update on table public.ocr_consensus_canary_runtime_v32 to postgres, service_role;

-- Replace the generic canary claim with a runtime-bound claim.  Even if another
-- is_canary row exists, it cannot be claimed unless it is one of the two jobs in
-- the explicitly activated cohort.
create or replace function public.claim_ocr_consensus_canary_v16(p_lease_seconds integer default 360)
returns table(id uuid,source_job_id uuid,article_count integer,is_canary boolean,lease_token uuid)
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_id uuid;
  v_token uuid:=gen_random_uuid();
  v_job_ids uuid[];
  v_unscoped_active integer:=0;
begin
  if p_lease_seconds < 60 or p_lease_seconds > 900 then raise exception 'ocr_consensus_v16_bad_lease'; end if;

  select array[r.job_id_1,r.job_id_2] into v_job_ids
  from public.ocr_consensus_canary_runtime_v32 r
  where r.singleton is true and r.active is true;
  if v_job_ids is null then return; end if;

  select count(*)::integer into v_unscoped_active
  from public.ocr_consensus_jobs_v11 j
  where j.is_canary is true
    and j.status in ('queued','running')
    and not (j.id=any(v_job_ids));
  if v_unscoped_active<>0 then raise exception 'ocr_consensus_v32_unscoped_active_canary'; end if;

  if exists(
    select 1 from public.ocr_consensus_jobs_v11 j
    where j.id=any(v_job_ids) and (j.is_canary is distinct from true or j.status='failed')
  ) then
    raise exception 'ocr_consensus_v32_bound_cohort_invalid_or_failed';
  end if;

  select j.id into v_id
  from public.ocr_consensus_jobs_v11 j
  join public.ocr_verification_page_jobs_v2 src on src.id=j.source_job_id
  where j.id=any(v_job_ids)
    and j.status='queued' and j.is_canary is true and j.lease_token is null
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

create or replace function public.drain_ocr_consensus_piece_v18_canary_v1()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','cron'
as $function$
declare
  r record;
  v_job_ids uuid[];
  v_active integer:=0;
  v_queued integer:=0;
  v_failed integer:=0;
  v_unscoped_active integer:=0;
  v_request_id bigint;
begin
  select array[x.job_id_1,x.job_id_2] into v_job_ids
  from public.ocr_consensus_canary_runtime_v32 x
  where x.singleton is true and x.active is true;

  if v_job_ids is null then
    if exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
      perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
    end if;
    return jsonb_build_object('status','blocked_no_active_runtime','cron_unscheduled',true);
  end if;

  select count(*)::integer into v_unscoped_active
  from public.ocr_consensus_jobs_v11 j
  where j.is_canary is true
    and j.status in ('queued','running')
    and not (j.id=any(v_job_ids));
  if v_unscoped_active<>0 then
    update public.ocr_consensus_canary_runtime_v32 set active=false,deactivated_at=now() where singleton is true;
    if exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
      perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
    end if;
    return jsonb_build_object('status','blocked_unscoped_active_canary','count',v_unscoped_active,'cron_unscheduled',true);
  end if;

  for r in
    select id,lease_token
    from public.ocr_consensus_jobs_v11
    where id=any(v_job_ids)
      and is_canary is true
      and status='running'
      and lease_token is not null
      and lease_expires_at<=now()
  loop
    perform public.fail_ocr_consensus_job_v11(
      r.id,r.lease_token,'Automatic recovery of expired v18 canary lease',true
    );
  end loop;

  select
    count(*) filter(where status in ('queued','running'))::integer,
    count(*) filter(where status='queued')::integer,
    count(*) filter(where status='failed')::integer
  into v_active,v_queued,v_failed
  from public.ocr_consensus_jobs_v11
  where id=any(v_job_ids) and is_canary is true;

  if v_failed>0 then
    update public.ocr_consensus_canary_runtime_v32 set active=false,deactivated_at=now() where singleton is true;
    if exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
      perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
    end if;
    return jsonb_build_object('status','blocked_failed','failed',v_failed,'active',v_active,'queued',v_queued,'cron_unscheduled',true);
  end if;

  if v_active=0 then
    update public.ocr_consensus_canary_runtime_v32 set active=false,deactivated_at=now() where singleton is true;
    if exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
      perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
    end if;
    return jsonb_build_object('status','complete','failed',0,'cron_unscheduled',true);
  end if;

  if v_queued=0 then
    return jsonb_build_object('status','busy','queued',0,'active',v_active,'failed',0);
  end if;

  v_request_id:=public.kick_ocr_consensus_piece_v18_canary_v1();
  return jsonb_build_object('status','kicked','request_id',v_request_id,'queued',v_queued,'active',v_active,'failed',0);
end
$function$;

revoke all on function public.drain_ocr_consensus_piece_v18_canary_v1() from public,anon,authenticated;
grant execute on function public.drain_ocr_consensus_piece_v18_canary_v1() to postgres,service_role;

create or replace function public.activate_ocr_consensus_canary_cohort_v32(p_cohort_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','cron'
as $function$
declare
  v_job_1 uuid;
  v_job_2 uuid;
  v_bad integer:=0;
  v_unscoped_active integer:=0;
  v_kick bigint;
begin
  select c.job_id_1,c.job_id_2 into v_job_1,v_job_2
  from public.ocr_consensus_canary_cohorts_v26 c where c.id=p_cohort_id;
  if v_job_1 is null or v_job_2 is null then raise exception 'ocr_consensus_v32_cohort_not_found'; end if;

  select count(*)::integer into v_bad
  from public.ocr_consensus_jobs_v11 j
  where j.id in (v_job_1,v_job_2)
    and (j.is_canary is distinct from true or j.status not in ('queued','running'));
  if v_bad<>0 then raise exception 'ocr_consensus_v32_cohort_not_runnable'; end if;

  select count(*)::integer into v_unscoped_active
  from public.ocr_consensus_jobs_v11 j
  where j.is_canary is true and j.status in ('queued','running') and j.id not in (v_job_1,v_job_2);
  if v_unscoped_active<>0 then raise exception 'ocr_consensus_v32_unscoped_active_canary'; end if;

  insert into public.ocr_consensus_canary_runtime_v32(singleton,cohort_id,job_id_1,job_id_2,active,activated_at,deactivated_at)
  values(true,p_cohort_id,v_job_1,v_job_2,true,now(),null)
  on conflict(singleton) do update set
    cohort_id=excluded.cohort_id,job_id_1=excluded.job_id_1,job_id_2=excluded.job_id_2,
    active=true,activated_at=now(),deactivated_at=null;

  if exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
    perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
  end if;
  perform cron.schedule(
    'ocr_consensus_piece_v18_canary_drain',
    '*/2 * * * *',
    'select public.drain_ocr_consensus_piece_v18_canary_v1();'
  );

  v_kick:=public.kick_ocr_consensus_piece_v18_canary_v1();
  return jsonb_build_object('status','activated','cohort_id',p_cohort_id,'job_ids',jsonb_build_array(v_job_1,v_job_2),'cron','*/2 * * * *','kick_request_id',v_kick);
end
$function$;

revoke all on function public.activate_ocr_consensus_canary_cohort_v32(uuid) from public,anon,authenticated;
grant execute on function public.activate_ocr_consensus_canary_cohort_v32(uuid) to postgres,service_role;

create or replace function public.restart_ocr_consensus_canaries_v32(p_job_ids uuid[],p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_restart jsonb;
  v_cohort_id uuid;
  v_activation jsonb;
begin
  select public.restart_ocr_consensus_canaries_v21_v22(p_job_ids,p_reason) into v_restart;
  v_cohort_id:=nullif(v_restart#>>'{cohort,cohort_id}','')::uuid;
  if v_cohort_id is null then raise exception 'ocr_consensus_v32_restart_missing_cohort'; end if;
  select public.activate_ocr_consensus_canary_cohort_v32(v_cohort_id) into v_activation;
  return v_restart||jsonb_build_object('runtime_activation',v_activation);
end
$function$;

revoke all on function public.restart_ocr_consensus_canaries_v32(uuid[],text) from public,anon,authenticated;
grant execute on function public.restart_ocr_consensus_canaries_v32(uuid[],text) to postgres,service_role;

comment on table public.ocr_consensus_canary_runtime_v32 is
  'Singleton runtime binding for one exact two-job OCR canary cohort. It never authorizes non-canary/full-rollout work.';

commit;

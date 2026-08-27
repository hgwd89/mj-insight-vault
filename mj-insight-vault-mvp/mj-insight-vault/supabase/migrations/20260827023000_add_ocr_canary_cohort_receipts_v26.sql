begin;

-- Durable identity for an exact two-job OCR canary restart cohort.  The cohort
-- receipt binds the two canary job IDs to the exact requeue archives produced by
-- one controlled restart, so post-completion comparison never has to infer a
-- cohort from timestamps, free-form job ordering, or "latest two" heuristics.
create table if not exists public.ocr_consensus_canary_cohorts_v26 (
  id uuid primary key default gen_random_uuid(),
  job_id_1 uuid not null references public.ocr_consensus_jobs_v11(id) on delete restrict,
  job_id_2 uuid not null references public.ocr_consensus_jobs_v11(id) on delete restrict,
  restart_archive_id_1 uuid not null references public.ocr_consensus_requeue_archives_v12(id) on delete restrict,
  restart_archive_id_2 uuid not null references public.ocr_consensus_requeue_archives_v12(id) on delete restrict,
  reason text not null,
  operation text not null default 'restart_ocr_consensus_canaries_v21_v22',
  created_at timestamptz not null default now(),
  constraint ocr_consensus_canary_cohorts_v26_job_order check (job_id_1::text < job_id_2::text),
  constraint ocr_consensus_canary_cohorts_v26_archive_distinct check (restart_archive_id_1 <> restart_archive_id_2),
  constraint ocr_consensus_canary_cohorts_v26_archive_pair_unique unique (restart_archive_id_1, restart_archive_id_2),
  constraint ocr_consensus_canary_cohorts_v26_reason_nonempty check (btrim(reason) <> ''),
  constraint ocr_consensus_canary_cohorts_v26_operation_fixed check (operation = 'restart_ocr_consensus_canaries_v21_v22')
);

alter table public.ocr_consensus_canary_cohorts_v26 enable row level security;
revoke all on public.ocr_consensus_canary_cohorts_v26 from public, anon, authenticated;
grant select, insert on public.ocr_consensus_canary_cohorts_v26 to postgres, service_role;

create or replace function public.register_ocr_consensus_canary_cohort_v26(
  p_job_ids uuid[],
  p_archive_ids uuid[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_reason text := btrim(coalesce(p_reason,''));
  v_expected_archive_reason text;
  v_job_a uuid;
  v_job_b uuid;
  v_archive_a uuid;
  v_archive_b uuid;
  v_job_1 uuid;
  v_job_2 uuid;
  v_archive_1 uuid;
  v_archive_2 uuid;
  v_canary_count integer := 0;
  v_archive_binding_count integer := 0;
  v_cohort_id uuid;
  v_created_at timestamptz;
begin
  if v_reason = '' then
    raise exception 'ocr_consensus_v26_cohort_reason_required';
  end if;
  if coalesce(cardinality(p_job_ids),0) <> 2 then
    raise exception 'ocr_consensus_v26_exactly_two_jobs_required';
  end if;
  if coalesce(cardinality(p_archive_ids),0) <> 2 then
    raise exception 'ocr_consensus_v26_exactly_two_archives_required';
  end if;

  v_job_a := p_job_ids[1];
  v_job_b := p_job_ids[2];
  v_archive_a := p_archive_ids[1];
  v_archive_b := p_archive_ids[2];

  if v_job_a is null or v_job_b is null or v_job_a = v_job_b then
    raise exception 'ocr_consensus_v26_job_set_not_bijective';
  end if;
  if v_archive_a is null or v_archive_b is null or v_archive_a = v_archive_b then
    raise exception 'ocr_consensus_v26_archive_set_not_bijective';
  end if;

  select count(*)::integer into v_canary_count
  from public.ocr_consensus_jobs_v11 j
  where j.id in (v_job_a,v_job_b)
    and j.is_canary is true;
  if v_canary_count <> 2 then
    raise exception 'ocr_consensus_v26_canary_jobs_required';
  end if;

  v_expected_archive_reason := format('v21/v2 clean restart: %s', v_reason);
  select count(*)::integer into v_archive_binding_count
  from (values (v_job_a,v_archive_a),(v_job_b,v_archive_b)) as x(job_id,archive_id)
  join public.ocr_consensus_requeue_archives_v12 a
    on a.id = x.archive_id
   and a.job_id = x.job_id
   and a.reason = v_expected_archive_reason;
  if v_archive_binding_count <> 2 then
    raise exception 'ocr_consensus_v26_archive_binding_invalid';
  end if;

  -- Canonical ordering makes the same job/archive pair have one durable identity
  -- regardless of caller array ordering while preserving each archive->job binding.
  if v_job_a::text < v_job_b::text then
    v_job_1 := v_job_a;
    v_job_2 := v_job_b;
    v_archive_1 := v_archive_a;
    v_archive_2 := v_archive_b;
  else
    v_job_1 := v_job_b;
    v_job_2 := v_job_a;
    v_archive_1 := v_archive_b;
    v_archive_2 := v_archive_a;
  end if;

  select c.id,c.created_at into v_cohort_id,v_created_at
  from public.ocr_consensus_canary_cohorts_v26 c
  where c.restart_archive_id_1 = v_archive_1
    and c.restart_archive_id_2 = v_archive_2;

  if found then
    if not exists (
      select 1 from public.ocr_consensus_canary_cohorts_v26 c
      where c.id = v_cohort_id
        and c.job_id_1 = v_job_1
        and c.job_id_2 = v_job_2
        and c.reason = v_reason
        and c.operation = 'restart_ocr_consensus_canaries_v21_v22'
    ) then
      raise exception 'ocr_consensus_v26_existing_cohort_mismatch';
    end if;
    return jsonb_build_object(
      'cohort_id',v_cohort_id,
      'status','already_registered',
      'job_ids',jsonb_build_array(v_job_1,v_job_2),
      'restart_archive_ids',jsonb_build_array(v_archive_1,v_archive_2),
      'reason',v_reason,
      'created_at',v_created_at
    );
  end if;

  insert into public.ocr_consensus_canary_cohorts_v26(
    job_id_1,job_id_2,restart_archive_id_1,restart_archive_id_2,reason
  ) values (
    v_job_1,v_job_2,v_archive_1,v_archive_2,v_reason
  )
  on conflict (restart_archive_id_1,restart_archive_id_2) do nothing
  returning id,created_at into v_cohort_id,v_created_at;

  if v_cohort_id is null then
    select c.id,c.created_at into v_cohort_id,v_created_at
    from public.ocr_consensus_canary_cohorts_v26 c
    where c.restart_archive_id_1 = v_archive_1
      and c.restart_archive_id_2 = v_archive_2
      and c.job_id_1 = v_job_1
      and c.job_id_2 = v_job_2
      and c.reason = v_reason
      and c.operation = 'restart_ocr_consensus_canaries_v21_v22';
    if not found then
      raise exception 'ocr_consensus_v26_concurrent_cohort_mismatch';
    end if;
  end if;

  return jsonb_build_object(
    'cohort_id',v_cohort_id,
    'status','registered',
    'job_ids',jsonb_build_array(v_job_1,v_job_2),
    'restart_archive_ids',jsonb_build_array(v_archive_1,v_archive_2),
    'reason',v_reason,
    'created_at',v_created_at
  );
end
$function$;

revoke all on function public.register_ocr_consensus_canary_cohort_v26(uuid[],uuid[],text) from public,anon,authenticated;
grant execute on function public.register_ocr_consensus_canary_cohort_v26(uuid[],uuid[],text) to postgres,service_role;

-- Replace the controlled restart with the same fail-closed restart semantics plus
-- atomic cohort registration.  Requeue archive IDs are captured from the actual
-- restart operation; no timestamp or job-order inference is used.
create or replace function public.restart_ocr_consensus_canaries_v21_v22(
  p_job_ids uuid[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','cron'
as $function$
declare
  v_target_count integer := 0;
  v_noncanary_count integer := 0;
  v_bad_status_count integer := 0;
  v_active_lease_count integer := 0;
  v_job_id uuid;
  v_requeue jsonb;
  v_requeues jsonb := '[]'::jsonb;
  v_archive_ids uuid[] := '{}'::uuid[];
  v_segments integer := 0;
  v_pass_runs integer := 0;
  v_transcriptions integer := 0;
  v_decisions integer := 0;
  v_canonicals integer := 0;
  v_bad_reset_count integer := 0;
  v_cron_rearmed boolean := false;
  v_cohort jsonb;
  v_kick jsonb;
begin
  if coalesce(nullif(btrim(p_reason),''),'')='' then
    raise exception 'ocr_consensus_v22_restart_reason_required';
  end if;
  if coalesce(array_length(p_job_ids,1),0)<>2 then
    raise exception 'ocr_consensus_v22_exactly_two_jobs_required';
  end if;

  select
    count(*)::integer,
    (count(*) filter(where j.is_canary is distinct from true))::integer,
    (count(*) filter(where j.status not in ('failed','queued','running')))::integer,
    (count(*) filter(where j.status='running' and j.lease_expires_at is not null and j.lease_expires_at>now()))::integer
  into v_target_count,v_noncanary_count,v_bad_status_count,v_active_lease_count
  from public.ocr_consensus_jobs_v11 j
  where j.id=any(p_job_ids);

  if v_target_count<>2 then raise exception 'ocr_consensus_v22_job_set_not_bijective'; end if;
  if v_noncanary_count<>0 then raise exception 'ocr_consensus_v22_canary_only'; end if;
  if v_bad_status_count<>0 then raise exception 'ocr_consensus_v22_bad_job_status'; end if;
  if v_active_lease_count<>0 then raise exception 'ocr_consensus_v22_active_lease'; end if;

  foreach v_job_id in array p_job_ids loop
    select public.requeue_ocr_consensus_canary_v12(
      v_job_id,
      format('v21/v2 clean restart: %s',btrim(p_reason))
    ) into v_requeue;
    v_requeues:=v_requeues||jsonb_build_array(v_requeue);
    v_archive_ids:=array_append(v_archive_ids,(v_requeue->>'archive_id')::uuid);
  end loop;

  if cardinality(v_archive_ids) <> 2 then
    raise exception 'ocr_consensus_v26_restart_archive_capture_invalid';
  end if;

  select count(*)::integer into v_segments
  from public.ocr_independent_segment_receipts_v16 where job_id=any(p_job_ids);
  select count(*)::integer into v_pass_runs
  from public.ocr_independent_pass_runs_v11 where job_id=any(p_job_ids);
  select count(*)::integer into v_transcriptions
  from public.ocr_independent_transcriptions_v11 where job_id=any(p_job_ids);
  select count(*)::integer into v_decisions
  from public.ocr_consensus_decisions_v11 where job_id=any(p_job_ids);
  select count(*)::integer into v_canonicals
  from public.article_ocr_verifications_v11 where source_consensus_job_id=any(p_job_ids);

  if v_segments<>0 or v_pass_runs<>0 or v_transcriptions<>0 or v_decisions<>0 or v_canonicals<>0 then
    raise exception 'ocr_consensus_v22_residual_current_evidence:segments=% pass_runs=% transcriptions=% decisions=% canonicals=%',
      v_segments,v_pass_runs,v_transcriptions,v_decisions,v_canonicals;
  end if;

  select count(*)::integer into v_bad_reset_count
  from public.ocr_consensus_jobs_v11 j
  where j.id=any(p_job_ids)
    and (j.status<>'queued' or j.failure_count<>0 or j.lease_token is not null or j.lease_expires_at is not null or j.error_message is not null or j.finished_at is not null);
  if v_bad_reset_count<>0 then raise exception 'ocr_consensus_v22_reset_state_invalid'; end if;

  select public.register_ocr_consensus_canary_cohort_v26(
    p_job_ids,
    v_archive_ids,
    p_reason
  ) into v_cohort;

  if not exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
    perform cron.schedule(
      'ocr_consensus_piece_v18_canary_drain',
      '* * * * *',
      'select public.drain_ocr_consensus_piece_v18_canary_v1();'
    );
    v_cron_rearmed:=true;
  end if;

  select public.kick_ocr_consensus_piece_canary_v18() into v_kick;

  return jsonb_build_object(
    'status','restarted_v21',
    'job_ids',to_jsonb(p_job_ids),
    'requeues',v_requeues,
    'cohort',v_cohort,
    'current_piece_receipts',v_segments,
    'current_pass_runs',v_pass_runs,
    'current_transcriptions',v_transcriptions,
    'current_decisions',v_decisions,
    'current_canonicals',v_canonicals,
    'cron_rearmed',v_cron_rearmed,
    'kick',v_kick
  );
end
$function$;

revoke all on function public.restart_ocr_consensus_canaries_v21_v22(uuid[],text) from public,anon,authenticated;
grant execute on function public.restart_ocr_consensus_canaries_v21_v22(uuid[],text) to postgres,service_role;

commit;

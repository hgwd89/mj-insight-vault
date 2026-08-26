-- Controlled V21 restart for exactly two explicitly supplied OCR consensus canaries.
-- This archives all pre-restart evidence through requeue_ocr_consensus_canary_v12,
-- verifies that no current evidence remains, rearms the canary-only drain, and
-- issues one authenticated kick. Any failure rolls back the entire restart.

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
  v_segments integer := 0;
  v_pass_runs integer := 0;
  v_transcriptions integer := 0;
  v_decisions integer := 0;
  v_canonicals integer := 0;
  v_bad_reset_count integer := 0;
  v_cron_rearmed boolean := false;
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

  -- A duplicate UUID in p_job_ids also produces v_target_count<2 and fails here.
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
  end loop;

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

  if not exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
    perform cron.schedule(
      'ocr_consensus_piece_v18_canary_drain',
      '* * * * *',
      'select public.drain_ocr_consensus_piece_v18_canary_v1();'
    );
    v_cron_rearmed:=true;
  end if;

  -- This kick function refuses to run if any non-canary OCR consensus job is
  -- runnable, so this operation cannot accidentally become the 538-job rollout.
  select public.kick_ocr_consensus_piece_canary_v18() into v_kick;

  return jsonb_build_object(
    'status','restarted_v21',
    'job_ids',to_jsonb(p_job_ids),
    'requeues',v_requeues,
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

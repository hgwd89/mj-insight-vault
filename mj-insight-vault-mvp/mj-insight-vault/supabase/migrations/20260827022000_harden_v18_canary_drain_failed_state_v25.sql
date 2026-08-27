-- Fail closed when canary lease recovery exhausts the retry budget.
-- A failed canary is not a completed canary: never report drain completion merely
-- because no queued/running rows remain.

create or replace function public.drain_ocr_consensus_piece_v18_canary_v1()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','cron'
as $$
declare
  r record;
  v_active int := 0;
  v_queued int := 0;
  v_failed int := 0;
  v_request_id bigint;
begin
  for r in
    select id, lease_token
    from public.ocr_consensus_jobs_v11
    where is_canary is true
      and status='running'
      and lease_token is not null
      and lease_expires_at<=now()
  loop
    perform public.fail_ocr_consensus_job_v11(
      r.id,
      r.lease_token,
      'Automatic recovery of expired v18 canary lease',
      true
    );
  end loop;

  select
    count(*) filter(where status in ('queued','running')),
    count(*) filter(where status='queued'),
    count(*) filter(where status='failed')
  into v_active, v_queued, v_failed
  from public.ocr_consensus_jobs_v11
  where is_canary is true;

  if v_failed>0 then
    if exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
      perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
    end if;
    return jsonb_build_object(
      'status','blocked_failed',
      'failed',v_failed,
      'active',v_active,
      'queued',v_queued,
      'cron_unscheduled',true
    );
  end if;

  if v_active=0 then
    if exists(select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain') then
      perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
    end if;
    return jsonb_build_object('status','complete','cron_unscheduled',true,'failed',0);
  end if;

  if v_queued=0 then
    return jsonb_build_object('status','busy','queued',0,'active',v_active,'failed',0);
  end if;

  v_request_id := public.kick_ocr_consensus_piece_v18_canary_v1();
  return jsonb_build_object('status','kicked','request_id',v_request_id,'queued',v_queued,'active',v_active,'failed',0);
end;
$$;

revoke all on function public.drain_ocr_consensus_piece_v18_canary_v1() from public, anon, authenticated;
grant execute on function public.drain_ocr_consensus_piece_v18_canary_v1() to postgres, service_role;

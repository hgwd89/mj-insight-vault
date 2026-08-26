create or replace function public.kick_ocr_consensus_piece_v18_canary_v1()
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog','public','vault','net'
as $$
declare
  v_password text;
  v_request_id bigint;
begin
  select s.decrypted_secret
    into v_password
  from vault.decrypted_secrets s
  where s.name='mj_report_worker_password'
  limit 1;

  if coalesce(v_password,'')='' then
    raise exception 'mj_report_worker_password is missing from Vault';
  end if;

  select net.http_post(
    url := 'https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/internal/ocr-consensus-piece-v18',
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-app-password',v_password
    ),
    timeout_milliseconds := 180000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.kick_ocr_consensus_piece_v18_canary_v1() from public, anon, authenticated;
grant execute on function public.kick_ocr_consensus_piece_v18_canary_v1() to postgres, service_role;

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
    count(*) filter(where status='queued')
  into v_active, v_queued
  from public.ocr_consensus_jobs_v11
  where is_canary is true;

  if v_active=0 then
    perform cron.unschedule('ocr_consensus_piece_v18_canary_drain');
    return jsonb_build_object('status','complete','cron_unscheduled',true);
  end if;

  if v_queued=0 then
    return jsonb_build_object('status','busy','queued',0,'active',v_active);
  end if;

  v_request_id := public.kick_ocr_consensus_piece_v18_canary_v1();
  return jsonb_build_object('status','kicked','request_id',v_request_id,'queued',v_queued,'active',v_active);
end;
$$;

revoke all on function public.drain_ocr_consensus_piece_v18_canary_v1() from public, anon, authenticated;
grant execute on function public.drain_ocr_consensus_piece_v18_canary_v1() to postgres, service_role;

select cron.schedule(
  'ocr_consensus_piece_v18_canary_drain',
  '* * * * *',
  $$select public.drain_ocr_consensus_piece_v18_canary_v1();$$
)
where not exists (
  select 1 from cron.job where jobname='ocr_consensus_piece_v18_canary_drain'
);

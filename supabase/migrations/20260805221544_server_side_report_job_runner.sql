create extension if not exists pg_cron;

create or replace function public.kick_active_report_job()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, vault, net
as $$
declare
  v_job_id uuid;
  v_password text;
  v_request_id bigint;
begin
  select j.id
    into v_job_id
  from public.chat_jobs j
  where j.status in ('queued', 'running')
    and coalesce(j.request_json ->> 'pipeline_version', '') = 'report_pipeline_v3'
    and (j.next_retry_at is null or j.next_retry_at <= now())
    and (
      j.status = 'queued'
      or j.lease_expires_at is null
      or j.lease_expires_at <= now()
    )
  order by j.created_at
  limit 1;

  if v_job_id is null then
    return null;
  end if;

  select s.decrypted_secret
    into v_password
  from vault.decrypted_secrets s
  where s.name = 'mj_report_worker_password'
  limit 1;

  if coalesce(v_password, '') = '' then
    raise exception 'mj_report_worker_password is missing from Vault';
  end if;

  select net.http_post(
    url := 'https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/chat/jobs/' || v_job_id::text || '/run',
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-app-password', v_password
    ),
    timeout_milliseconds := 300000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.kick_active_report_job() from public, anon, authenticated;
grant execute on function public.kick_active_report_job() to postgres, service_role;

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'mj_report_worker' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
  perform cron.schedule(
    'mj_report_worker',
    '* * * * *',
    'select public.kick_active_report_job();'
  );
end;
$$;
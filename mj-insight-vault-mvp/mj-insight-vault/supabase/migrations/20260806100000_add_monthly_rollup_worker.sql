-- Run monthly rollups as short resumable worker steps instead of one long Vercel request.

alter table public.monthly_rollups
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_retry_at timestamptz;

create index if not exists monthly_rollups_worker_idx
  on public.monthly_rollups(status, next_retry_at, lease_expires_at, updated_at);

create or replace function public.enqueue_monthly_rollup(
  p_month_key text,
  p_force boolean default false
)
returns setof public.monthly_rollups
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_month_key <> 'undated' and p_month_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month_key: %', p_month_key;
  end if;

  insert into public.monthly_rollups (
    month_key,
    status,
    rollup_model,
    summary_text,
    summary_json,
    error_message,
    updated_at
  ) values (
    p_month_key,
    'queued',
    '',
    'Monthly rollup queued.',
    '{}'::jsonb,
    null,
    now()
  )
  on conflict (month_key) do update
  set status = case
        when monthly_rollups.status = 'running'
          and monthly_rollups.lease_expires_at is not null
          and monthly_rollups.lease_expires_at > now()
          then monthly_rollups.status
        when p_force or monthly_rollups.status <> 'ready' then 'queued'
        else monthly_rollups.status
      end,
      summary_text = case
        when monthly_rollups.status = 'running'
          and monthly_rollups.lease_expires_at is not null
          and monthly_rollups.lease_expires_at > now()
          then monthly_rollups.summary_text
        when p_force then 'Monthly rollup queued for a clean rebuild.'
        else monthly_rollups.summary_text
      end,
      summary_json = case
        when monthly_rollups.status = 'running'
          and monthly_rollups.lease_expires_at is not null
          and monthly_rollups.lease_expires_at > now()
          then monthly_rollups.summary_json
        when p_force then '{}'::jsonb
        else monthly_rollups.summary_json
      end,
      error_message = case
        when monthly_rollups.status = 'running'
          and monthly_rollups.lease_expires_at is not null
          and monthly_rollups.lease_expires_at > now()
          then monthly_rollups.error_message
        else null
      end,
      lease_token = case
        when monthly_rollups.status = 'running'
          and monthly_rollups.lease_expires_at is not null
          and monthly_rollups.lease_expires_at > now()
          then monthly_rollups.lease_token
        else null
      end,
      lease_expires_at = case
        when monthly_rollups.status = 'running'
          and monthly_rollups.lease_expires_at is not null
          and monthly_rollups.lease_expires_at > now()
          then monthly_rollups.lease_expires_at
        else null
      end,
      heartbeat_at = case
        when monthly_rollups.status = 'running'
          and monthly_rollups.lease_expires_at is not null
          and monthly_rollups.lease_expires_at > now()
          then monthly_rollups.heartbeat_at
        else null
      end,
      attempt_count = case when p_force then 0 else monthly_rollups.attempt_count end,
      next_retry_at = null,
      updated_at = now();

  return query
  select * from public.monthly_rollups where month_key = p_month_key;
end;
$$;

create or replace function public.claim_monthly_rollup(
  p_month_key text,
  p_lease_seconds integer default 180
)
returns setof public.monthly_rollups
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  update public.monthly_rollups r
  set status = 'running',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 600))),
      heartbeat_at = now(),
      updated_at = now()
  where r.month_key = p_month_key
    and (r.next_retry_at is null or r.next_retry_at <= now())
    and (
      r.status in ('queued', 'stale', 'failed', 'provisional')
      or (r.status = 'running' and (r.lease_expires_at is null or r.lease_expires_at <= now()))
    )
  returning r.*;
end;
$$;

create or replace function public.claim_next_monthly_rollup(
  p_lease_seconds integer default 180
)
returns setof public.monthly_rollups
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with candidate as (
    select r.id
    from public.monthly_rollups r
    where (r.next_retry_at is null or r.next_retry_at <= now())
      and (
        r.status in ('queued', 'stale', 'failed', 'provisional')
        or (r.status = 'running' and (r.lease_expires_at is null or r.lease_expires_at <= now()))
      )
    order by
      case r.status when 'running' then 0 when 'failed' then 1 when 'provisional' then 2 else 3 end,
      r.updated_at,
      r.month_key
    for update skip locked
    limit 1
  )
  update public.monthly_rollups r
  set status = 'running',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 600))),
      heartbeat_at = now(),
      updated_at = now()
  from candidate c
  where r.id = c.id
  returning r.*;
end;
$$;

revoke all on function public.enqueue_monthly_rollup(text, boolean) from public, anon, authenticated;
revoke all on function public.claim_monthly_rollup(text, integer) from public, anon, authenticated;
revoke all on function public.claim_next_monthly_rollup(integer) from public, anon, authenticated;
grant execute on function public.enqueue_monthly_rollup(text, boolean) to postgres, service_role;
grant execute on function public.claim_monthly_rollup(text, integer) to postgres, service_role;
grant execute on function public.claim_next_monthly_rollup(integer) to postgres, service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.kick_monthly_rollup_worker()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, vault, net
as $$
declare
  v_exists boolean;
  v_password text;
  v_request_id bigint;
begin
  select exists(
    select 1
    from public.monthly_rollups r
    where (r.next_retry_at is null or r.next_retry_at <= now())
      and (
        r.status in ('queued', 'stale', 'failed', 'provisional')
        or (r.status = 'running' and (r.lease_expires_at is null or r.lease_expires_at <= now()))
      )
  ) into v_exists;

  if not v_exists then
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
    url := 'https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/rollups/monthly/worker',
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-app-password', v_password
    ),
    timeout_milliseconds := 240000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.kick_monthly_rollup_worker() from public, anon, authenticated;
grant execute on function public.kick_monthly_rollup_worker() to postgres, service_role;

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'mj_monthly_rollup_worker' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
  perform cron.schedule(
    'mj_monthly_rollup_worker',
    '* * * * *',
    'select public.kick_monthly_rollup_worker();'
  );
end;
$$;

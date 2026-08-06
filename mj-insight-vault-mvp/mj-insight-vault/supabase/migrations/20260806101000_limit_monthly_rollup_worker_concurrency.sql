-- Keep monthly LLM work globally serial to avoid rate spikes and duplicate cost.
-- Atomic row leases still protect each month; this adds a project-wide concurrency cap of one.

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
    and not exists (
      select 1
      from public.monthly_rollups active
      where active.id <> r.id
        and active.status = 'running'
        and active.lease_expires_at > now()
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
  if exists (
    select 1
    from public.monthly_rollups active
    where active.status = 'running'
      and active.lease_expires_at > now()
  ) then
    return;
  end if;

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
    and not exists (
      select 1
      from public.monthly_rollups active
      where active.id <> r.id
        and active.status = 'running'
        and active.lease_expires_at > now()
    )
  returning r.*;
end;
$$;

revoke all on function public.claim_monthly_rollup(text, integer) from public, anon, authenticated;
revoke all on function public.claim_next_monthly_rollup(integer) from public, anon, authenticated;
grant execute on function public.claim_monthly_rollup(text, integer) to postgres, service_role;
grant execute on function public.claim_next_monthly_rollup(integer) to postgres, service_role;

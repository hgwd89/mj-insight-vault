begin;

create unique index if not exists chat_jobs_single_active_v3_uidx
  on public.chat_jobs ((1))
  where status in ('queued', 'running')
    and request_json ->> 'pipeline_version' = 'report_pipeline_v3';

create or replace function public.claim_chat_job(
  p_job_id uuid,
  p_lease_seconds integer default 360
)
returns setof public.chat_jobs
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 360), 900));
  v_token uuid := gen_random_uuid();
begin
  return query
  update public.chat_jobs j
  set status = 'running',
      lease_token = v_token,
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      next_retry_at = null,
      started_at = coalesce(j.started_at, now()),
      finished_at = null,
      heartbeat_at = now(),
      updated_at = now(),
      error_message = null
  where j.id = p_job_id
    and j.report_id is null
    and (
      (
        j.status = 'queued'
        and coalesce(j.next_retry_at, '-infinity'::timestamptz) <= now()
      )
      or
      (
        j.status = 'running'
        and coalesce(j.lease_expires_at, j.heartbeat_at + interval '6 minutes') <= now()
      )
    )
  returning j.*;
end;
$$;

revoke all on function public.claim_chat_job(uuid, integer) from public;
revoke all on function public.claim_chat_job(uuid, integer) from anon;
revoke all on function public.claim_chat_job(uuid, integer) from authenticated;
grant execute on function public.claim_chat_job(uuid, integer) to service_role;

commit;
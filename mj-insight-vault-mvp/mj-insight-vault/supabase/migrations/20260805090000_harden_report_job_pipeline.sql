begin;

alter table public.chat_jobs
  add column if not exists attempt_count integer not null default 0,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists next_retry_at timestamptz;

alter table public.chat_jobs
  drop constraint if exists chat_jobs_attempt_count_check;

alter table public.chat_jobs
  add constraint chat_jobs_attempt_count_check
  check (attempt_count >= 0 and attempt_count <= 50);

create index if not exists chat_jobs_active_created_at_idx
  on public.chat_jobs (created_at desc)
  where status in ('queued', 'running');

create index if not exists chat_jobs_retry_at_idx
  on public.chat_jobs (next_retry_at)
  where status = 'queued' and next_retry_at is not null;

alter table public.full_corpus_scan_runs
  add column if not exists corpus_fingerprint text;

create unique index if not exists full_corpus_scan_runs_active_fingerprint_uidx
  on public.full_corpus_scan_runs (
    scope_type,
    coalesce(scope_query, ''),
    corpus_fingerprint
  )
  where corpus_fingerprint is not null
    and status in ('queued', 'running', 'completed');

alter table public.full_corpus_scan_batches
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_error_class text;

alter table public.full_corpus_scan_batches
  drop constraint if exists full_corpus_scan_batches_attempt_count_check;

alter table public.full_corpus_scan_batches
  add constraint full_corpus_scan_batches_attempt_count_check
  check (attempt_count >= 0 and attempt_count <= 20);

create index if not exists full_corpus_scan_batches_retry_idx
  on public.full_corpus_scan_batches (run_id, next_retry_at, batch_index)
  where status in ('queued', 'failed', 'needs_review', 'running');

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
      attempt_count = j.attempt_count + 1,
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

create or replace function public.claim_full_corpus_scan_batch(
  p_batch_id uuid,
  p_expected_status text,
  p_expected_updated_at timestamptz default null
)
returns setof public.full_corpus_scan_batches
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  return query
  update public.full_corpus_scan_batches b
  set status = 'running',
      attempt_count = b.attempt_count + 1,
      next_retry_at = null,
      last_error_class = null,
      started_at = now(),
      finished_at = null,
      updated_at = now(),
      error_message = null
  where b.id = p_batch_id
    and b.status = p_expected_status
    and coalesce(b.next_retry_at, '-infinity'::timestamptz) <= now()
    and (
      p_expected_status <> 'running'
      or p_expected_updated_at is null
      or b.updated_at = p_expected_updated_at
    )
  returning b.*;
end;
$$;

revoke all on function public.claim_chat_job(uuid, integer) from public;
revoke all on function public.claim_chat_job(uuid, integer) from anon;
revoke all on function public.claim_chat_job(uuid, integer) from authenticated;
grant execute on function public.claim_chat_job(uuid, integer) to service_role;

revoke all on function public.claim_full_corpus_scan_batch(uuid, text, timestamptz) from public;
revoke all on function public.claim_full_corpus_scan_batch(uuid, text, timestamptz) from anon;
revoke all on function public.claim_full_corpus_scan_batch(uuid, text, timestamptz) from authenticated;
grant execute on function public.claim_full_corpus_scan_batch(uuid, text, timestamptz) to service_role;

commit;

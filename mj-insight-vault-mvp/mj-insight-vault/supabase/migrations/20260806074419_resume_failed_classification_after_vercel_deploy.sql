create table if not exists public.pipeline_runner_state (
  state_key text primary key,
  state_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.pipeline_runner_state enable row level security;
revoke all on table public.pipeline_runner_state from public, anon, authenticated;
grant all on table public.pipeline_runner_state to service_role;

create or replace function public.poll_vercel_production_status_v1()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, vault, net
as $$
declare
  v_previous_request_id bigint;
  v_response jsonb;
  v_sha text := '';
  v_vercel_state text := '';
  v_target_url text := '';
  v_last_success_sha text := '';
  v_new_request_id bigint;
  v_requeued integer := 0;
begin
  select nullif(state_value->>'request_id','')::bigint
    into v_previous_request_id
  from public.pipeline_runner_state
  where state_key = 'vercel_status_poll';

  select coalesce(state_value->>'last_success_sha','')
    into v_last_success_sha
  from public.pipeline_runner_state
  where state_key = 'vercel_status_poll';

  if v_previous_request_id is not null then
    select content::jsonb into v_response
    from net._http_response
    where id = v_previous_request_id
      and status_code = 200
      and not timed_out;

    if v_response is not null then
      v_sha := coalesce(v_response->>'sha','');
      select coalesce(item->>'state',''), coalesce(item->>'target_url','')
        into v_vercel_state, v_target_url
      from jsonb_array_elements(coalesce(v_response->'statuses','[]'::jsonb)) item
      where item->>'context' = 'Vercel – hgwd89-mj-insight-vault-k5k2'
      limit 1;

      if v_vercel_state = 'success' and v_sha <> '' and v_sha <> v_last_success_sha then
        update public.article_classification_jobs
        set status = 'queued',
            attempt_count = 0,
            error_message = null,
            next_retry_at = null,
            lease_token = null,
            lease_expires_at = null,
            finished_at = null,
            updated_at = now()
        where classifier_version = 'article_category_profile_v2'
          and status = 'failed';
        get diagnostics v_requeued = row_count;
        v_last_success_sha := v_sha;
      end if;
    end if;
  end if;

  v_new_request_id := net.http_get(
    url := 'https://api.github.com/repos/hgwd89/mj-insight-vault/commits/main/status',
    headers := jsonb_build_object('User-Agent','mj-insight-vault-runner','Accept','application/vnd.github+json'),
    timeout_milliseconds := 15000
  );

  insert into public.pipeline_runner_state(state_key, state_value, updated_at)
  values (
    'vercel_status_poll',
    jsonb_build_object(
      'request_id', v_new_request_id,
      'observed_sha', v_sha,
      'vercel_state', v_vercel_state,
      'target_url', v_target_url,
      'last_success_sha', v_last_success_sha,
      'requeued_failed_classifications', v_requeued
    ),
    now()
  )
  on conflict (state_key) do update
  set state_value = excluded.state_value,
      updated_at = excluded.updated_at;

  return jsonb_build_object(
    'observed_sha', v_sha,
    'vercel_state', v_vercel_state,
    'requeued_failed_classifications', v_requeued,
    'next_request_id', v_new_request_id
  );
end;
$$;

revoke all on function public.poll_vercel_production_status_v1() from public, anon, authenticated;
grant execute on function public.poll_vercel_production_status_v1() to service_role;

do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'mj-vercel-status-poll-v1' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
end $$;

select cron.schedule(
  'mj-vercel-status-poll-v1',
  '*/10 * * * *',
  'select public.poll_vercel_production_status_v1();'
);
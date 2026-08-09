create or replace function public.kick_article_classification_loop_v1()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, vault
as $$
declare
  v_password text;
  v_queued integer := 0;
  v_running integer := 0;
  v_retryable integer := 0;
  v_slots integer := 0;
  v_sent integer := 0;
begin
  select decrypted_secret into v_password
  from vault.decrypted_secrets
  where name = 'mj_report_loop_password'
  order by created_at desc
  limit 1;

  if coalesce(v_password, '') = '' then
    return jsonb_build_object('status', 'blocked', 'reason', 'runner_password_missing');
  end if;

  select
    count(*) filter (where status = 'queued' and (next_retry_at is null or next_retry_at <= now())),
    count(*) filter (where status = 'running' and lease_expires_at > now()),
    count(*) filter (where status = 'failed' and attempt_count < 3 and (next_retry_at is null or next_retry_at <= now()))
  into v_queued, v_running, v_retryable
  from public.article_classification_jobs
  where classifier_version = 'article_category_profile_v2';

  v_slots := greatest(0, least(6, v_queued + v_retryable) - v_running);

  for i in 1..v_slots loop
    perform net.http_post(
      url := 'https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/classification/worker',
      body := jsonb_build_object('limit', 1),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-app-password', v_password),
      timeout_milliseconds := 240000
    );
    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('status', case when v_sent > 0 then 'kicked' else 'idle' end, 'queued', v_queued, 'running', v_running, 'retryable', v_retryable, 'requests_sent', v_sent);
end;
$$;
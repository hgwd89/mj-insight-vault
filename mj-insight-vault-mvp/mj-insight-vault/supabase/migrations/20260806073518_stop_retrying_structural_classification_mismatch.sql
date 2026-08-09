create or replace function public.fail_article_classification_job_v2(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_message text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_job public.article_classification_jobs%rowtype;
  v_retry boolean;
  v_structural boolean;
begin
  select * into v_job
  from public.article_classification_jobs j
  where j.id = p_job_id
    and j.status = 'running'
    and j.lease_token = p_lease_token
  for update;

  if not found then
    return jsonb_build_object('job_id', p_job_id, 'updated', false, 'reason', 'lease_lost');
  end if;

  v_structural := lower(coalesce(p_error_message, '')) like '%primary category missing from memberships%';
  v_retry := coalesce(p_retryable, true)
    and not v_structural
    and v_job.attempt_count < 3;

  update public.article_classification_jobs
  set status = case when v_retry then 'queued' else 'failed' end,
      next_retry_at = case when v_retry then now() + make_interval(secs => least(300, 20 * power(2, greatest(0, v_job.attempt_count - 1))::integer)) else null end,
      error_message = left(coalesce(p_error_message, 'classification failed'), 2000),
      lease_token = null,
      lease_expires_at = null,
      heartbeat_at = now(),
      updated_at = now(),
      finished_at = case when v_retry then null else now() end
  where id = v_job.id;

  return jsonb_build_object(
    'job_id', v_job.id,
    'article_id', v_job.article_id,
    'retry_scheduled', v_retry,
    'attempt_count', v_job.attempt_count,
    'structural_failure', v_structural
  );
end;
$$;
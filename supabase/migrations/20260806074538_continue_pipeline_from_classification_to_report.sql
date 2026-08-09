create or replace function public.ensure_formal_report_job_v1()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_gate text := 'failed';
  v_gate_reason text := '';
  v_formal_count integer := 0;
  v_profiled_count integer := 0;
  v_categorized_count integer := 0;
  v_active_job_id uuid;
  v_existing_state_job_id uuid;
  v_existing_state_status text;
  v_job_id uuid;
  v_now timestamptz := now();
  v_query text := '全記事を対象に、生活者インサイトの総合レポートを作成してください。主要トレンド、背景要因、反証可能な仮説、負の空間、今後のリサーチ課題を、実在する記事根拠とともに示してください。企業施策を生活者需要の証明へ変換しないでください。';
begin
  select category_classification_gate, gate_reason, formal_article_count, profiled_article_count, categorized_article_count
    into v_gate, v_gate_reason, v_formal_count, v_profiled_count, v_categorized_count
  from public.category_classification_gate_v1;

  if v_gate <> 'passed' then
    return jsonb_build_object(
      'status','waiting_for_classification',
      'gate',v_gate,
      'reason',v_gate_reason,
      'formal_articles',v_formal_count,
      'profiled_articles',v_profiled_count,
      'categorized_articles',v_categorized_count
    );
  end if;

  select id into v_active_job_id
  from public.chat_jobs
  where status in ('queued','running')
    and request_json->>'pipeline_version' = 'report_pipeline_v3'
  order by created_at desc
  limit 1;

  if v_active_job_id is not null then
    return jsonb_build_object('status','active_job_exists','job_id',v_active_job_id);
  end if;

  select nullif(state_value->>'job_id','')::uuid
    into v_existing_state_job_id
  from public.pipeline_runner_state
  where state_key = 'formal_report_loop';

  if v_existing_state_job_id is not null then
    select status into v_existing_state_status
    from public.chat_jobs
    where id = v_existing_state_job_id;

    if v_existing_state_status = 'completed' and exists (
      select 1 from public.chat_reports r
      where r.source_job_id = v_existing_state_job_id
        and r.is_formal_report = true
    ) then
      update public.pipeline_runner_state
      set state_value = state_value || jsonb_build_object('status','completed','completed_at',now()), updated_at=now()
      where state_key='formal_report_loop';
      return jsonb_build_object('status','completed','job_id',v_existing_state_job_id);
    end if;

    if v_existing_state_status in ('queued','running') then
      return jsonb_build_object('status','tracked_job_active','job_id',v_existing_state_job_id);
    end if;

    if v_existing_state_status = 'failed' then
      return jsonb_build_object('status','tracked_job_failed','job_id',v_existing_state_job_id);
    end if;
  end if;

  insert into public.chat_jobs(
    status, progress, stage, user_query, request_json, result_json, report_id,
    error_message, attempt_count, started_at, finished_at, heartbeat_at, next_retry_at
  ) values (
    'queued', 3, 'ジョブを作成しました', v_query,
    jsonb_build_object(
      'query', v_query,
      'target_scope', 'all',
      'require_full_corpus', true,
      'model', 'gpt-4o-mini',
      'pipeline_version', 'report_pipeline_v3'
    ),
    null, null, null, 0, null, null, v_now, null
  ) returning id into v_job_id;

  insert into public.pipeline_runner_state(state_key,state_value,updated_at)
  values('formal_report_loop',jsonb_build_object('job_id',v_job_id,'status','queued','created_at',v_now),v_now)
  on conflict(state_key) do update
    set state_value=excluded.state_value, updated_at=excluded.updated_at;

  return jsonb_build_object('status','job_created','job_id',v_job_id);
end;
$$;

revoke all on function public.ensure_formal_report_job_v1() from public, anon, authenticated;
grant execute on function public.ensure_formal_report_job_v1() to service_role;

create or replace function public.kick_active_v2_corpus_scan_v1()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, vault
as $$
declare
  v_password text;
  v_run_id uuid;
  v_request_id bigint;
begin
  select decrypted_secret into v_password
  from vault.decrypted_secrets
  where name='mj_report_loop_password'
  order by created_at desc
  limit 1;

  if coalesce(v_password,'')='' then
    return jsonb_build_object('status','blocked','reason','runner_password_missing');
  end if;

  select id into v_run_id
  from public.full_corpus_scan_runs
  where status in ('queued','running')
    and scope_type='all'
    and coalesce(coverage_json->>'prompt_version','')='full_corpus_batch_v2'
  order by created_at desc
  limit 1;

  if v_run_id is null then
    return jsonb_build_object('status','idle');
  end if;

  v_request_id := net.http_post(
    url := 'https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/corpus-scans/progress',
    body := jsonb_build_object('id',v_run_id,'batch_limit',3),
    headers := jsonb_build_object('Content-Type','application/json','x-app-password',v_password),
    timeout_milliseconds := 290000
  );

  return jsonb_build_object('status','kicked','run_id',v_run_id,'request_id',v_request_id);
end;
$$;

revoke all on function public.kick_active_v2_corpus_scan_v1() from public, anon, authenticated;
grant execute on function public.kick_active_v2_corpus_scan_v1() to service_role;

do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='mj-formal-report-orchestrator-v1' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  select jobid into v_job_id from cron.job where jobname='mj-v2-scan-accelerator-v1' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
end $$;

select cron.schedule('mj-formal-report-orchestrator-v1','* * * * *','select public.ensure_formal_report_job_v1();');
select cron.schedule('mj-v2-scan-accelerator-v1','* * * * *','select public.kick_active_v2_corpus_scan_v1();');
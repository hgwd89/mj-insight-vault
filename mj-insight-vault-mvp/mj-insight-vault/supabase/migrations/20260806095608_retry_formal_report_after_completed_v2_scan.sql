create or replace function public.ensure_formal_report_job_v1()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_gate text := 'failed';
  v_gate_reason text := '';
  v_formal_count integer := 0;
  v_profiled_count integer := 0;
  v_categorized_count integer := 0;
  v_active_job_id uuid;
  v_existing_state_job_id uuid;
  v_existing_state_status text;
  v_existing_job_updated_at timestamptz;
  v_state jsonb := '{}'::jsonb;
  v_latest_run_id uuid;
  v_latest_run_finished_at timestamptz;
  v_last_retry_run_id uuid;
  v_retry_count integer := 0;
  v_job_id uuid;
  v_now timestamptz := now();
  v_query text := '全記事を対象に、生活者インサイトの総合レポートを作成してください。主要トレンド、背景要因、反証可能な仮説、負の空間、今後のリサーチ課題を、実在する記事根拠とともに示してください。企業施策を生活者需要の証明へ変換しないでください。';
begin
  select category_classification_gate, gate_reason, formal_article_count, profiled_article_count, categorized_article_count
    into v_gate, v_gate_reason, v_formal_count, v_profiled_count, v_categorized_count
  from public.category_classification_gate_v1;

  if v_gate <> 'passed' then
    return jsonb_build_object('status','waiting_for_classification','gate',v_gate,'reason',v_gate_reason,'formal_articles',v_formal_count,'profiled_articles',v_profiled_count,'categorized_articles',v_categorized_count);
  end if;

  select r.id, r.finished_at
    into v_latest_run_id, v_latest_run_finished_at
  from public.full_corpus_scan_runs r
  where r.scope_type='all'
    and r.status='completed'
    and coalesce(r.coverage_json->>'prompt_version','')='full_corpus_batch_v2'
    and coalesce(r.coverage_json->>'full_corpus_gate','')='passed'
    and r.failed_batches=0
    and r.needs_review_batches=0
    and r.completed_batches=r.total_batches
    and r.analyzed_article_count=r.ocr_ready_article_count
    and r.analyzed_article_count>0
  order by r.finished_at desc nulls last, r.created_at desc
  limit 1;

  if v_latest_run_id is null then
    return jsonb_build_object('status','waiting_for_completed_v2_scan');
  end if;

  select id into v_active_job_id
  from public.chat_jobs
  where status in ('queued','running')
    and request_json->>'pipeline_version'='report_pipeline_v3'
  order by created_at desc limit 1;

  if v_active_job_id is not null then
    return jsonb_build_object('status','active_job_exists','job_id',v_active_job_id);
  end if;

  select state_value into v_state
  from public.pipeline_runner_state
  where state_key='formal_report_loop';

  v_existing_state_job_id := case when coalesce(v_state->>'job_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_state->>'job_id')::uuid else null end;
  v_last_retry_run_id := case when coalesce(v_state->>'last_retry_run_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_state->>'last_retry_run_id')::uuid else null end;
  begin v_retry_count := coalesce((v_state->>'retry_count')::integer,0); exception when others then v_retry_count := 0; end;

  if v_existing_state_job_id is not null then
    select status, updated_at into v_existing_state_status, v_existing_job_updated_at
    from public.chat_jobs where id=v_existing_state_job_id;

    if v_existing_state_status='completed' and exists(select 1 from public.chat_reports r where r.source_job_id=v_existing_state_job_id and r.is_formal_report=true) then
      update public.pipeline_runner_state set state_value=state_value||jsonb_build_object('status','completed','completed_at',now()), updated_at=now() where state_key='formal_report_loop';
      return jsonb_build_object('status','completed','job_id',v_existing_state_job_id);
    end if;

    if v_existing_state_status in ('queued','running') then
      return jsonb_build_object('status','tracked_job_active','job_id',v_existing_state_job_id);
    end if;

    if v_existing_state_status='failed' and (v_last_retry_run_id=v_latest_run_id or v_retry_count>=3) then
      return jsonb_build_object('status','tracked_job_failed_for_current_run','job_id',v_existing_state_job_id,'run_id',v_latest_run_id,'retry_count',v_retry_count);
    end if;

    if v_existing_state_status='failed' and not (v_latest_run_finished_at > coalesce(v_existing_job_updated_at,'epoch'::timestamptz)) then
      return jsonb_build_object('status','tracked_job_failed_waiting_for_new_scan','job_id',v_existing_state_job_id,'run_id',v_latest_run_id);
    end if;
  end if;

  insert into public.chat_jobs(status,progress,stage,user_query,request_json,result_json,report_id,error_message,attempt_count,started_at,finished_at,heartbeat_at,next_retry_at)
  values('queued',3,'ジョブを作成しました',v_query,
    jsonb_build_object('query',v_query,'target_scope','all','require_full_corpus',true,'model','gpt-4o-mini','pipeline_version','report_pipeline_v3','expected_full_corpus_run_id',v_latest_run_id),
    null,null,null,0,null,null,v_now,null)
  returning id into v_job_id;

  insert into public.pipeline_runner_state(state_key,state_value,updated_at)
  values('formal_report_loop',jsonb_build_object('job_id',v_job_id,'status','queued','created_at',v_now,'last_retry_run_id',v_latest_run_id,'retry_count',v_retry_count+1),v_now)
  on conflict(state_key) do update set state_value=excluded.state_value,updated_at=excluded.updated_at;

  return jsonb_build_object('status','job_created','job_id',v_job_id,'run_id',v_latest_run_id,'retry_count',v_retry_count+1);
end;
$function$;
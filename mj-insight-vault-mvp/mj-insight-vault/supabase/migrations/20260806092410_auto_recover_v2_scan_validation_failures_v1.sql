create or replace function public.kick_active_v2_corpus_scan_v1()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions','vault'
as $function$
declare
  v_password text;
  v_run_id uuid;
  v_request_id bigint;
  v_split_10 jsonb := '{}'::jsonb;
  v_split_5 jsonb := '{}'::jsonb;
  v_split_3 jsonb := '{}'::jsonb;
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
  where status in ('queued','running','needs_review')
    and scope_type='all'
    and coalesce(coverage_json->>'prompt_version','')='full_corpus_batch_v2'
  order by created_at desc
  limit 1;

  if v_run_id is null then
    return jsonb_build_object('status','idle');
  end if;

  if exists (
    select 1 from public.full_corpus_scan_batches b
    where b.run_id=v_run_id
      and b.status in ('failed','needs_review')
      and coalesce(b.last_error_class,'')='validation'
  ) then
    v_split_10 := public.split_validation_failed_v2_scan_batches_v1(v_run_id,10);
    v_split_5 := public.split_validation_failed_v2_scan_batches_v1(v_run_id,5);
    v_split_3 := public.split_validation_failed_v2_scan_batches_v1(v_run_id,3);
  end if;

  v_request_id := net.http_post(
    url := 'https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/corpus-scans/progress',
    body := jsonb_build_object('id',v_run_id,'batch_limit',3),
    headers := jsonb_build_object('Content-Type','application/json','x-app-password',v_password),
    timeout_milliseconds := 290000
  );

  return jsonb_build_object(
    'status','kicked',
    'run_id',v_run_id,
    'request_id',v_request_id,
    'split_10',v_split_10,
    'split_5',v_split_5,
    'split_3',v_split_3
  );
end;
$function$;
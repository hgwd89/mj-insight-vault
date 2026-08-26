create or replace function public.kick_ocr_consensus_segment_canary_v16()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','vault','net'
as $function$
declare
  v_password text;
  v_request_id bigint;
  v_queued integer;
  v_noncanary integer;
begin
  select count(*)::integer into v_queued
  from public.ocr_consensus_jobs_v11
  where is_canary=true and status='queued';

  select count(*)::integer into v_noncanary
  from public.ocr_consensus_jobs_v11
  where is_canary is distinct from true and status in ('queued','running');

  if v_queued=0 then
    return jsonb_build_object('status','idle','queued_canaries',0);
  end if;
  if v_noncanary<>0 then
    raise exception 'ocr_consensus_segment_v16_noncanary_runnable';
  end if;

  select decrypted_secret into v_password
  from vault.decrypted_secrets
  where name='mj_report_worker_password'
  order by created_at desc
  limit 1;
  if coalesce(v_password,'')='' then raise exception 'ocr_consensus_segment_v16_worker_password_missing'; end if;

  v_request_id:=net.http_post(
    url:='https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/internal/ocr-consensus-segment-v16',
    body:='{}'::jsonb,
    params:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','x-app-password',v_password),
    timeout_milliseconds:=240000
  );
  return jsonb_build_object('status','kicked','request_id',v_request_id,'queued_canaries',v_queued);
end
$function$;

revoke all on function public.kick_ocr_consensus_segment_canary_v16() from public,anon,authenticated;
grant execute on function public.kick_ocr_consensus_segment_canary_v16() to postgres,service_role;

begin;

create or replace function public.kick_ocr_segment_google_probe_v14()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'vault', 'net'
as $function$
declare
  v_password text;
  v_expected integer;
  v_done integer;
  v_request_id bigint;
begin
  if exists(
    select 1 from public.ocr_consensus_jobs_v11
    where is_canary is distinct from true
      and status in ('running')
  ) then
    raise exception 'ocr_segment_google_v14_noncanary_running';
  end if;

  select coalesce(sum(article_count),0)::integer into v_expected
  from public.ocr_consensus_jobs_v11
  where is_canary=true and status in ('needs_review','queued','completed');

  select count(*)::integer into v_done
  from public.ocr_segment_google_probes_v14 p
  join public.ocr_consensus_jobs_v11 j on j.id=p.job_id
  where j.is_canary=true;

  if v_expected=0 or v_done>=v_expected then
    return jsonb_build_object('status','complete','expected',v_expected,'done',v_done);
  end if;

  select decrypted_secret into v_password
  from vault.decrypted_secrets
  where name='mj_report_worker_password'
  order by created_at desc
  limit 1;
  if coalesce(v_password,'')='' then raise exception 'mj_report_worker_password is missing from Vault'; end if;

  select net.http_post(
    url:='https://hgwd89-mj-insight-vault-k5k2.vercel.app/api/internal/ocr-segment-google-v14',
    body:='{}'::jsonb,
    params:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','x-app-password',v_password),
    timeout_milliseconds:=240000
  ) into v_request_id;

  return jsonb_build_object('status','kicked','request_id',v_request_id,'expected',v_expected,'done',v_done);
end
$function$;

revoke all on function public.kick_ocr_segment_google_probe_v14() from public, anon, authenticated;
grant execute on function public.kick_ocr_segment_google_probe_v14() to postgres, service_role;

commit;

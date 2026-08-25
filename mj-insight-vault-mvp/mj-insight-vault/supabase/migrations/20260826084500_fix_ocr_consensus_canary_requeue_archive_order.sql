begin;

create or replace function public.requeue_ocr_consensus_canary_v12(
  p_job_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_snapshot jsonb;
  v_archive_id uuid;
  v_pass_runs integer;
  v_transcriptions integer;
  v_decisions integer;
  v_canonicals integer;
begin
  select * into j
  from public.ocr_consensus_jobs_v11
  where id = p_job_id
  for update;

  if not found then raise exception 'ocr_consensus_v12_job_missing'; end if;
  if j.is_canary is distinct from true then raise exception 'ocr_consensus_v12_canary_only'; end if;
  if j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at > now() then raise exception 'ocr_consensus_v12_active_lease'; end if;
  if coalesce(nullif(btrim(p_reason), ''), '') = '' then raise exception 'ocr_consensus_v12_reason_required'; end if;

  select jsonb_build_object(
    'job', to_jsonb(j),
    'pass_runs', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from public.ocr_independent_pass_runs_v11 x where x.job_id = j.id), '[]'::jsonb),
    'transcriptions', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.pass_kind, x.article_id) from public.ocr_independent_transcriptions_v11 x where x.job_id = j.id), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(to_jsonb(x) order by x.decided_at, x.article_id) from public.ocr_consensus_decisions_v11 x where x.job_id = j.id), '[]'::jsonb),
    'canonicals', coalesce((select jsonb_agg(to_jsonb(x) order by x.verified_at, x.article_id) from public.article_ocr_verifications_v11 x where x.source_consensus_job_id = j.id), '[]'::jsonb)
  ) into v_snapshot;

  insert into public.ocr_consensus_requeue_archives_v12(job_id, reason, snapshot_json)
  values (j.id, btrim(p_reason), v_snapshot)
  returning id into v_archive_id;

  delete from public.article_ocr_verifications_v11 where source_consensus_job_id = j.id;
  get diagnostics v_canonicals = row_count;
  delete from public.ocr_consensus_decisions_v11 where job_id = j.id;
  get diagnostics v_decisions = row_count;
  delete from public.ocr_independent_transcriptions_v11 where job_id = j.id;
  get diagnostics v_transcriptions = row_count;
  delete from public.ocr_independent_pass_runs_v11 where job_id = j.id;
  get diagnostics v_pass_runs = row_count;

  update public.ocr_consensus_jobs_v11
  set status = 'queued', failure_count = 0, lease_token = null, lease_expires_at = null,
      error_message = null, finished_at = null, updated_at = now()
  where id = j.id;

  return jsonb_build_object('archive_id', v_archive_id, 'job_id', j.id, 'status', 'queued',
    'deleted_pass_runs', v_pass_runs, 'deleted_transcriptions', v_transcriptions,
    'deleted_decisions', v_decisions, 'deleted_canonicals', v_canonicals);
end
$function$;

revoke all on function public.requeue_ocr_consensus_canary_v12(uuid,text) from public, anon, authenticated;
grant execute on function public.requeue_ocr_consensus_canary_v12(uuid,text) to postgres, service_role;

commit;

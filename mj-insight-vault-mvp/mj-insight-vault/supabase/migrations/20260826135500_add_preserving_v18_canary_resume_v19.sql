create table if not exists public.ocr_consensus_resume_receipts_v19 (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ocr_consensus_jobs_v11(id) on delete cascade,
  reason text not null,
  previous_status text not null,
  previous_failure_count integer not null,
  previous_error_message text,
  preserved_piece_receipts integer not null,
  segmentation_versions text[] not null,
  created_at timestamptz not null default now()
);

alter table public.ocr_consensus_resume_receipts_v19 enable row level security;
revoke all on public.ocr_consensus_resume_receipts_v19 from public, anon, authenticated;
grant select, insert on public.ocr_consensus_resume_receipts_v19 to postgres, service_role;

create or replace function public.resume_ocr_consensus_canary_v19(
  p_job_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path to 'pg_catalog', 'public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_piece_count integer := 0;
  v_versions text[] := '{}'::text[];
begin
  if coalesce(nullif(btrim(p_reason), ''), '') = '' then
    raise exception 'ocr_consensus_v19_resume_reason_required';
  end if;

  select * into j
  from public.ocr_consensus_jobs_v11
  where id = p_job_id
  for update;

  if not found then raise exception 'ocr_consensus_v19_job_missing'; end if;
  if j.is_canary is distinct from true then raise exception 'ocr_consensus_v19_canary_only'; end if;
  if j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at > now() then
    raise exception 'ocr_consensus_v19_active_lease';
  end if;
  if j.status not in ('failed','queued') then
    raise exception 'ocr_consensus_v19_resume_bad_status:%', j.status;
  end if;

  select count(*)::int,
         coalesce(array_agg(distinct r.segmentation_version order by r.segmentation_version), '{}'::text[])
    into v_piece_count, v_versions
  from public.ocr_independent_segment_receipts_v16 r
  where r.job_id = j.id;

  if v_piece_count > 0 and v_versions <> array['article_block_local_vertical_segments_v1']::text[] then
    raise exception 'ocr_consensus_v19_incompatible_piece_version:%', array_to_string(v_versions, ',');
  end if;

  insert into public.ocr_consensus_resume_receipts_v19(
    job_id, reason, previous_status, previous_failure_count, previous_error_message,
    preserved_piece_receipts, segmentation_versions
  ) values (
    j.id, btrim(p_reason), j.status, j.failure_count, j.error_message,
    v_piece_count, v_versions
  );

  update public.ocr_consensus_jobs_v11
     set status = 'queued',
         failure_count = 0,
         lease_token = null,
         lease_expires_at = null,
         error_message = null,
         finished_at = null,
         updated_at = now()
   where id = j.id;

  return jsonb_build_object(
    'job_id', j.id,
    'status', 'queued',
    'preserved_piece_receipts', v_piece_count,
    'segmentation_versions', to_jsonb(v_versions)
  );
end
$function$;

revoke all on function public.resume_ocr_consensus_canary_v19(uuid,text) from public, anon, authenticated;
grant execute on function public.resume_ocr_consensus_canary_v19(uuid,text) to postgres, service_role;

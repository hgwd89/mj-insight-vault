begin;

create table if not exists public.ocr_verification_requeue_archives_v10(
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  partition_job_id uuid not null,
  reason text not null,
  archived_by text not null default 'service_role_manual_requeue',
  snapshot_json jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.ocr_verification_requeue_archives_v10 enable row level security;
revoke all on public.ocr_verification_requeue_archives_v10 from public,anon,authenticated,service_role;
grant select on public.ocr_verification_requeue_archives_v10 to service_role;
create index if not exists ocr_verification_requeue_archives_v10_job_idx on public.ocr_verification_requeue_archives_v10(job_id,created_at desc);

create or replace function public.requeue_ocr_verification_page_job_v10(p_job_id uuid,p_reason text)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  v_archive uuid;
  v_snapshot jsonb;
begin
  select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
  if not found then raise exception 'ocr_requeue_v10_job_missing'; end if;
  if j.status not in ('needs_review','failed') then raise exception 'ocr_requeue_v10_status_invalid'; end if;
  if char_length(btrim(coalesce(p_reason,'')))<8 then raise exception 'ocr_requeue_v10_reason_required'; end if;

  v_snapshot:=jsonb_build_object(
    'job',to_jsonb(j),
    'source_binary_receipt',(select to_jsonb(r) from public.ocr_verification_source_binary_receipts_v8 r where r.job_id=j.id),
    'crop_rows',coalesce((select jsonb_agg(to_jsonb(c) order by c.article_id) from public.ocr_verification_crop_ocr_v4 c where c.job_id=j.id),'[]'::jsonb),
    'vision_chunks',coalesce((select jsonb_agg(to_jsonb(c) order by c.pass_kind,c.chunk_index) from public.ocr_verification_vision_chunks_v4 c where c.job_id=j.id),'[]'::jsonb),
    'transcriptions',coalesce((select jsonb_agg(to_jsonb(t) order by t.pass_kind,t.article_id) from public.ocr_verification_transcriptions_v2 t where t.job_id=j.id),'[]'::jsonb),
    'final_verifications',coalesce((select jsonb_agg(to_jsonb(v) order by v.article_id) from public.article_ocr_verifications_v1 v where v.partition_job_id=j.partition_job_id and v.verification_version='article_ocr_verification_v5_crop_ocr_plus_independent_vision'),'[]'::jsonb)
  );

  insert into public.ocr_verification_requeue_archives_v10(job_id,partition_job_id,reason,snapshot_json)
  values(j.id,j.partition_job_id,left(btrim(p_reason),2000),v_snapshot)
  returning id into v_archive;

  delete from public.article_ocr_verifications_v1 where partition_job_id=j.partition_job_id and verification_version='article_ocr_verification_v5_crop_ocr_plus_independent_vision';
  delete from public.ocr_verification_transcriptions_v2 where job_id=j.id;
  delete from public.ocr_verification_vision_chunks_v4 where job_id=j.id;
  delete from public.ocr_verification_crop_ocr_v4 where job_id=j.id;
  delete from public.ocr_verification_source_binary_receipts_v8 where job_id=j.id;

  update public.ocr_verification_page_jobs_v2
  set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,failure_count=0,error_message=null,started_at=null,finished_at=null,updated_at=now()
  where id=j.id;

  return jsonb_build_object('status','queued','job_id',j.id,'archive_id',v_archive,'proof_reset',true);
end
$function$;

revoke all on function public.requeue_ocr_verification_page_job_v10(uuid,text) from public,anon,authenticated;
grant execute on function public.requeue_ocr_verification_page_job_v10(uuid,text) to service_role;

commit;
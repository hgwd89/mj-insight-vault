-- Segment-level independent OCR v16.
-- Canary-only execution path. Existing v11 decision thresholds are unchanged.

create table if not exists public.ocr_independent_segment_receipts_v16(
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ocr_consensus_jobs_v11(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('sol','terra')),
  article_id uuid not null,
  sequence integer not null check(sequence > 0),
  segment_count integer not null check(segment_count > 0 and sequence <= segment_count),
  model text not null,
  segmentation_version text not null,
  segmentation_spec_sha256 text not null check(segmentation_spec_sha256 ~ '^[0-9a-f]{64}$'),
  segment_image_sha256 text not null check(segment_image_sha256 ~ '^[0-9a-f]{64}$'),
  transcription text not null check(length(btrim(transcription)) > 0),
  transcription_sha256 text not null check(transcription_sha256 ~ '^[0-9a-f]{64}$'),
  confidence numeric not null check(confidence between 0 and 1),
  proper_noun_status text not null check(proper_noun_status in ('passed','not_applicable','failed')),
  visual_proper_nouns text[] not null default '{}',
  output_contract_status text not null check(output_contract_status in ('passed','failed')),
  reason text not null default '',
  provider_response_id text not null,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(job_id,pass_kind,article_id,sequence),
  unique(provider_response_id),
  unique(prompt_sha256)
);

alter table public.ocr_independent_segment_receipts_v16 enable row level security;
revoke all on public.ocr_independent_segment_receipts_v16 from public,anon,authenticated;
grant select,insert,update,delete on public.ocr_independent_segment_receipts_v16 to postgres,service_role;

create or replace function public.claim_ocr_consensus_canary_v16(p_lease_seconds integer default 360)
returns table(id uuid,source_job_id uuid,article_count integer,is_canary boolean,lease_token uuid)
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_id uuid;
  v_token uuid:=gen_random_uuid();
begin
  if p_lease_seconds < 60 or p_lease_seconds > 900 then raise exception 'ocr_consensus_v16_bad_lease'; end if;
  select j.id into v_id
  from public.ocr_consensus_jobs_v11 j
  join public.ocr_verification_page_jobs_v2 src on src.id=j.source_job_id
  where j.status='queued' and j.is_canary is true and j.lease_token is null
    and exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=src.freeze_receipt_id)
    and (select count(*) from public.ocr_verification_crop_ocr_v4 c where c.job_id=j.source_job_id and c.crop_version='article_geometry_mask_composite_v3')=j.article_count
  order by j.created_at,j.id
  for update of j skip locked
  limit 1;
  if v_id is null then return; end if;
  update public.ocr_consensus_jobs_v11
     set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
   where id=v_id;
  return query select j.id,j.source_job_id,j.article_count,j.is_canary,j.lease_token from public.ocr_consensus_jobs_v11 j where j.id=v_id;
end
$function$;

create or replace function public.append_ocr_independent_segment_v16(
  p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_article_id uuid,p_sequence integer,p_segment_count integer,
  p_model text,p_segmentation_version text,p_segmentation_spec_sha256 text,p_segment_image_sha256 text,
  p_transcription text,p_confidence numeric,p_proper_noun_status text,p_visual_proper_nouns text[],p_output_contract_status text,p_reason text,
  p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_existing_model text;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id=p_job_id for update;
  if not found or j.is_canary is distinct from true then raise exception 'ocr_consensus_v16_canary_only'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_consensus_v16_lease_invalid'; end if;
  if p_pass_kind not in ('sol','terra') or p_sequence<1 or p_segment_count<1 or p_sequence>p_segment_count then raise exception 'ocr_consensus_v16_segment_invalid'; end if;
  if coalesce(p_model,'')='' or coalesce(p_segmentation_version,'')='' then raise exception 'ocr_consensus_v16_model_or_version_missing'; end if;
  if coalesce(p_segmentation_spec_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_segment_image_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_prompt_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_response_sha256,'')!~'^[0-9a-f]{64}$' then raise exception 'ocr_consensus_v16_hash_invalid'; end if;
  if coalesce(btrim(p_transcription),'')='' or p_confidence not between 0 and 1 then raise exception 'ocr_consensus_v16_transcription_invalid'; end if;
  if p_proper_noun_status not in ('passed','not_applicable','failed') or p_output_contract_status not in ('passed','failed') then raise exception 'ocr_consensus_v16_contract_invalid'; end if;
  if not exists(select 1 from public.ocr_verification_crop_ocr_v4 c where c.job_id=j.source_job_id and c.article_id=p_article_id and c.crop_version='article_geometry_mask_composite_v3') then raise exception 'ocr_consensus_v16_unknown_article'; end if;

  select model into v_existing_model from public.ocr_independent_segment_receipts_v16 where job_id=j.id and pass_kind=p_pass_kind limit 1;
  if v_existing_model is not null and v_existing_model<>p_model then raise exception 'ocr_consensus_v16_model_changed_within_pass'; end if;
  if exists(select 1 from public.ocr_independent_segment_receipts_v16 where job_id=j.id and pass_kind<>p_pass_kind and model=p_model) then raise exception 'ocr_consensus_v16_independent_model_required'; end if;

  insert into public.ocr_independent_segment_receipts_v16(
    job_id,pass_kind,article_id,sequence,segment_count,model,segmentation_version,segmentation_spec_sha256,segment_image_sha256,
    transcription,transcription_sha256,confidence,proper_noun_status,visual_proper_nouns,output_contract_status,reason,
    provider_response_id,prompt_sha256,response_sha256
  ) values(
    j.id,p_pass_kind,p_article_id,p_sequence,p_segment_count,p_model,p_segmentation_version,p_segmentation_spec_sha256,p_segment_image_sha256,
    p_transcription,encode(extensions.digest(convert_to(p_transcription,'UTF8'),'sha256'),'hex'),p_confidence,p_proper_noun_status,coalesce(p_visual_proper_nouns,'{}'::text[]),p_output_contract_status,left(coalesce(p_reason,''),1500),
    p_provider_response_id,p_prompt_sha256,p_response_sha256
  );
  return jsonb_build_object('status','stored','article_id',p_article_id,'pass_kind',p_pass_kind,'sequence',p_sequence,'segment_count',p_segment_count);
end
$function$;

-- Preserve v12 semantics while also archiving/removing segment receipts on canary reset.
create or replace function public.requeue_ocr_consensus_canary_v12(p_job_id uuid,p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_snapshot jsonb;
  v_archive_id uuid;
  v_pass_runs integer;
  v_transcriptions integer;
  v_decisions integer;
  v_canonicals integer;
  v_segments integer;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id=p_job_id for update;
  if not found then raise exception 'ocr_consensus_v12_job_missing'; end if;
  if j.is_canary is distinct from true then raise exception 'ocr_consensus_v12_canary_only'; end if;
  if j.status='running' and j.lease_expires_at is not null and j.lease_expires_at>now() then raise exception 'ocr_consensus_v12_active_lease'; end if;
  if coalesce(nullif(btrim(p_reason),''),'')='' then raise exception 'ocr_consensus_v12_reason_required'; end if;

  select jsonb_build_object(
    'job',to_jsonb(j),
    'segment_receipts',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.pass_kind,x.article_id,x.sequence) from public.ocr_independent_segment_receipts_v16 x where x.job_id=j.id),'[]'::jsonb),
    'pass_runs',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.id) from public.ocr_independent_pass_runs_v11 x where x.job_id=j.id),'[]'::jsonb),
    'transcriptions',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at,x.pass_kind,x.article_id) from public.ocr_independent_transcriptions_v11 x where x.job_id=j.id),'[]'::jsonb),
    'decisions',coalesce((select jsonb_agg(to_jsonb(x) order by x.decided_at,x.article_id) from public.ocr_consensus_decisions_v11 x where x.job_id=j.id),'[]'::jsonb),
    'canonicals',coalesce((select jsonb_agg(to_jsonb(x) order by x.verified_at,x.article_id) from public.article_ocr_verifications_v11 x where x.source_consensus_job_id=j.id),'[]'::jsonb)
  ) into v_snapshot;

  insert into public.ocr_consensus_requeue_archives_v12(job_id,reason,snapshot_json) values(j.id,btrim(p_reason),v_snapshot) returning id into v_archive_id;
  delete from public.article_ocr_verifications_v11 where source_consensus_job_id=j.id; get diagnostics v_canonicals=row_count;
  delete from public.ocr_consensus_decisions_v11 where job_id=j.id; get diagnostics v_decisions=row_count;
  delete from public.ocr_independent_transcriptions_v11 where job_id=j.id; get diagnostics v_transcriptions=row_count;
  delete from public.ocr_independent_pass_runs_v11 where job_id=j.id; get diagnostics v_pass_runs=row_count;
  delete from public.ocr_independent_segment_receipts_v16 where job_id=j.id; get diagnostics v_segments=row_count;

  update public.ocr_consensus_jobs_v11 set status='queued',failure_count=0,lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('archive_id',v_archive_id,'job_id',j.id,'status','queued','deleted_segments',v_segments,'deleted_pass_runs',v_pass_runs,'deleted_transcriptions',v_transcriptions,'deleted_decisions',v_decisions,'deleted_canonicals',v_canonicals);
end
$function$;

revoke all on function public.claim_ocr_consensus_canary_v16(integer) from public,anon,authenticated;
grant execute on function public.claim_ocr_consensus_canary_v16(integer) to postgres,service_role;
revoke all on function public.append_ocr_independent_segment_v16(uuid,uuid,text,uuid,integer,integer,text,text,text,text,text,numeric,text,text[],text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.append_ocr_independent_segment_v16(uuid,uuid,text,uuid,integer,integer,text,text,text,text,text,numeric,text,text[],text,text,text,text,text) to postgres,service_role;
revoke all on function public.requeue_ocr_consensus_canary_v12(uuid,text) from public,anon,authenticated;
grant execute on function public.requeue_ocr_consensus_canary_v12(uuid,text) to postgres,service_role;

-- OCR Consensus v11: independent-evidence OCR verification.
--
-- Google Vision OCR, GPT-5.6 Sol, and GPT-5.6 Terra are captured as three
-- independent transcriptions of the same geometry-preserving article crop.
-- Sol and Terra never see Google's candidate text (see
-- lib/ocrConsensusWorkerV11.ts); Google is used only as a third independent
-- evidence source inside decide_ocr_consensus_article_v11's comparison.
--
-- This migration reproduces the v11 schema/function DDL that was applied
-- directly to production (project wqbjtvepnavkqdshppau) so the repository
-- matches production. It is a documentation/reconciliation migration only:
-- do not re-apply it to production, and do not weaken any threshold below
-- when editing this file later.
--
-- Known pre-existing gap (not introduced by this migration): the legacy OCR
-- verification layer this depends on (ocr_verification_page_jobs_v2,
-- ocr_verification_crop_ocr_v4, ocr_grounded_articles_for_partition_v1, and
-- the deeper grounded-partition/region chain it reads) is also not present
-- in any repository migration. That gap predates v11 and is out of scope
-- for this change; it should be reconciled separately.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- Shared normalization helpers
-- ---------------------------------------------------------------------

create or replace function public.normalize_ocr_consensus_text_v2(p_text text)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
  select lower(regexp_replace(translate(coalesce(p_text,''),'０１２３４５６７８９％，．　','0123456789%,. '),'[[:space:]。、，,.・「」『』（）()【】［］\[\]：:；;!！?？\-―ー]','','g'))
$function$;

create or replace function public.ocr_numeric_tokens_v2(p_text text)
returns text[]
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
  select coalesce(array_agg(distinct m[1] order by m[1]),'{}'::text[])
  from regexp_matches(replace(translate(coalesce(p_text,''),'０１２３４５６７８９％．','0123456789%.'),',',''),'([0-9]+(?:\.[0-9]+)?%?)','g') m
$function$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.ocr_consensus_jobs_v11(
  id uuid primary key default gen_random_uuid(),
  source_job_id uuid not null unique references public.ocr_verification_page_jobs_v2(id) on delete restrict,
  pipeline_version text not null default 'independent_visual_consensus_v11',
  article_count integer not null check(article_count > 0),
  is_canary boolean not null default false,
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  failure_count integer not null default 0 check(failure_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.ocr_consensus_jobs_v11 enable row level security;
revoke all on public.ocr_consensus_jobs_v11 from public,anon,authenticated;
grant select,insert,update,delete on public.ocr_consensus_jobs_v11 to postgres,service_role;

create table if not exists public.ocr_independent_pass_runs_v11(
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ocr_consensus_jobs_v11(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('sol','terra')),
  chunk_index integer not null check(chunk_index >= 0),
  model text not null,
  provider_response_id text not null unique,
  prompt_sha256 text not null unique check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  input_binding_sha256 text not null check(input_binding_sha256 ~ '^[0-9a-f]{64}$'),
  article_set_fingerprint text not null check(article_set_fingerprint ~ '^[0-9a-f]{64}$'),
  article_count integer not null check(article_count >= 1 and article_count <= 4),
  created_at timestamptz not null default now(),
  unique(job_id,pass_kind,chunk_index)
);

alter table public.ocr_independent_pass_runs_v11 enable row level security;
revoke all on public.ocr_independent_pass_runs_v11 from public,anon,authenticated;
grant select,insert,update,delete on public.ocr_independent_pass_runs_v11 to postgres,service_role;

create table if not exists public.ocr_independent_transcriptions_v11(
  job_id uuid not null references public.ocr_consensus_jobs_v11(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('sol','terra')),
  article_id uuid not null,
  transcription text not null check(char_length(btrim(transcription)) > 0),
  transcription_sha256 text not null check(transcription_sha256 ~ '^[0-9a-f]{64}$'),
  confidence numeric not null check(confidence >= 0 and confidence <= 1),
  proper_noun_status text not null check(proper_noun_status in ('passed','not_applicable','failed')),
  visual_proper_nouns text[] not null default '{}'::text[],
  output_contract_status text not null default 'passed' check(output_contract_status in ('passed','failed')),
  reason text,
  pass_run_id uuid not null references public.ocr_independent_pass_runs_v11(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(job_id,pass_kind,article_id)
);

alter table public.ocr_independent_transcriptions_v11 enable row level security;
revoke all on public.ocr_independent_transcriptions_v11 from public,anon,authenticated;
grant select,insert,update,delete on public.ocr_independent_transcriptions_v11 to postgres,service_role;

create table if not exists public.ocr_consensus_decisions_v11(
  job_id uuid not null references public.ocr_consensus_jobs_v11(id) on delete cascade,
  article_id uuid not null,
  decision_status text not null check(decision_status in ('passed_single','passed_two_model','needs_review')),
  selected_source text check(selected_source in ('sol','terra')),
  canonical_text text,
  canonical_text_sha256 text,
  google_sol_similarity numeric,
  google_terra_similarity numeric,
  sol_terra_similarity numeric,
  google_sol_numeric_equal boolean,
  google_terra_numeric_equal boolean,
  sol_terra_numeric_equal boolean,
  sol_terra_proper_noun_agreement boolean,
  decision_reason text not null,
  decided_at timestamptz not null default now(),
  primary key(job_id,article_id),
  check(
    (decision_status like 'passed_%' and selected_source is not null and canonical_text is not null and canonical_text_sha256 ~ '^[0-9a-f]{64}$')
    or
    (decision_status = 'needs_review' and selected_source is null and canonical_text is null and canonical_text_sha256 is null)
  )
);

alter table public.ocr_consensus_decisions_v11 enable row level security;
revoke all on public.ocr_consensus_decisions_v11 from public,anon,authenticated;
grant select,insert,update,delete on public.ocr_consensus_decisions_v11 to postgres,service_role;

create table if not exists public.article_ocr_verifications_v11(
  article_id uuid primary key,
  source_consensus_job_id uuid not null references public.ocr_consensus_jobs_v11(id) on delete restrict,
  source_legacy_job_id uuid not null references public.ocr_verification_page_jobs_v2(id) on delete restrict,
  verification_version text not null default 'independent_visual_consensus_v11',
  canonical_text text not null,
  canonical_text_sha256 text not null check(canonical_text_sha256 ~ '^[0-9a-f]{64}$'),
  selected_source text not null check(selected_source in ('sol','terra')),
  google_crop_text_sha256 text not null check(google_crop_text_sha256 ~ '^[0-9a-f]{64}$'),
  sol_text_sha256 text not null check(sol_text_sha256 ~ '^[0-9a-f]{64}$'),
  terra_text_sha256 text,
  quality_status text not null default 'passed' check(quality_status = 'passed'),
  quality_reason text not null,
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.article_ocr_verifications_v11 enable row level security;
revoke all on public.article_ocr_verifications_v11 from public,anon,authenticated;
grant select,insert,update,delete on public.article_ocr_verifications_v11 to postgres,service_role;

-- ---------------------------------------------------------------------
-- Evidence view: joins the three independent sources and computes
-- similarity / numeric-token equality / proper-noun agreement. Google
-- text is read here only for comparison -- it is never sent to Sol/Terra.
-- ---------------------------------------------------------------------

create or replace view public.ocr_consensus_evidence_v11 as
select
  cj.id as job_id,
  cj.source_job_id,
  g.article_id,
  g.crop_ocr_text as google_text,
  g.crop_ocr_text_sha256 as google_text_sha256,
  s.transcription as sol_text,
  s.transcription_sha256 as sol_text_sha256,
  s.confidence as sol_confidence,
  s.proper_noun_status as sol_proper_noun_status,
  s.visual_proper_nouns as sol_visual_proper_nouns,
  s.output_contract_status as sol_output_contract_status,
  t.transcription as terra_text,
  t.transcription_sha256 as terra_text_sha256,
  t.confidence as terra_confidence,
  t.proper_noun_status as terra_proper_noun_status,
  t.visual_proper_nouns as terra_visual_proper_nouns,
  t.output_contract_status as terra_output_contract_status,
  case when s.transcription is null then null::real
       else similarity(normalize_ocr_consensus_text_v2(g.crop_ocr_text), normalize_ocr_consensus_text_v2(s.transcription))
  end as google_sol_similarity,
  case when t.transcription is null then null::real
       else similarity(normalize_ocr_consensus_text_v2(g.crop_ocr_text), normalize_ocr_consensus_text_v2(t.transcription))
  end as google_terra_similarity,
  case when s.transcription is null or t.transcription is null then null::real
       else similarity(normalize_ocr_consensus_text_v2(s.transcription), normalize_ocr_consensus_text_v2(t.transcription))
  end as sol_terra_similarity,
  case when s.transcription is null then null::boolean
       else ocr_numeric_tokens_v2(g.crop_ocr_text) = ocr_numeric_tokens_v2(s.transcription)
  end as google_sol_numeric_equal,
  case when t.transcription is null then null::boolean
       else ocr_numeric_tokens_v2(g.crop_ocr_text) = ocr_numeric_tokens_v2(t.transcription)
  end as google_terra_numeric_equal,
  case when s.transcription is null or t.transcription is null then null::boolean
       else ocr_numeric_tokens_v2(s.transcription) = ocr_numeric_tokens_v2(t.transcription)
  end as sol_terra_numeric_equal,
  case when s.transcription is null or t.transcription is null then null::boolean
       else
         not exists(select 1 from unnest(s.visual_proper_nouns) n(n) where position(normalize_ocr_consensus_text_v2(n.n) in normalize_ocr_consensus_text_v2(t.transcription)) = 0)
         and
         not exists(select 1 from unnest(t.visual_proper_nouns) n(n) where position(normalize_ocr_consensus_text_v2(n.n) in normalize_ocr_consensus_text_v2(s.transcription)) = 0)
  end as sol_terra_proper_noun_agreement
from public.ocr_consensus_jobs_v11 cj
join public.ocr_verification_crop_ocr_v4 g on g.job_id = cj.source_job_id and g.crop_version = 'article_geometry_mask_composite_v3'
left join public.ocr_independent_transcriptions_v11 s on s.job_id = cj.id and s.pass_kind = 'sol' and s.article_id = g.article_id
left join public.ocr_independent_transcriptions_v11 t on t.job_id = cj.id and t.pass_kind = 'terra' and t.article_id = g.article_id;

revoke all on public.ocr_consensus_evidence_v11 from public,anon,authenticated;
grant select on public.ocr_consensus_evidence_v11 to postgres,service_role;

-- ---------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------

create or replace function public.claim_ocr_consensus_job_v11(p_lease_seconds integer default 360)
returns table(id uuid, source_job_id uuid, article_count integer, is_canary boolean, lease_token uuid)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_id uuid;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_seconds < 60 or p_lease_seconds > 900 then raise exception 'ocr_consensus_v11_bad_lease'; end if;
  select j.id into v_id
  from public.ocr_consensus_jobs_v11 j
  join public.ocr_verification_page_jobs_v2 src on src.id = j.source_job_id
  where j.status = 'queued'
    and j.lease_token is null
    and exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2 = 'passed' and fg.freeze_receipt_id = src.freeze_receipt_id)
    and (select count(*) from public.ocr_verification_crop_ocr_v4 c where c.job_id = j.source_job_id and c.crop_version = 'article_geometry_mask_composite_v3') = j.article_count
  order by j.is_canary desc, j.created_at, j.id
  for update of j skip locked
  limit 1;
  if v_id is null then return; end if;
  update public.ocr_consensus_jobs_v11 j
     set status = 'running', lease_token = v_token, lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   where j.id = v_id;
  return query select j.id, j.source_job_id, j.article_count, j.is_canary, j.lease_token from public.ocr_consensus_jobs_v11 j where j.id = v_id;
end
$function$;

revoke all on function public.claim_ocr_consensus_job_v11(integer) from public, anon, authenticated;
grant execute on function public.claim_ocr_consensus_job_v11(integer) to postgres, service_role;

create or replace function public.get_ocr_consensus_page_input_v11(p_job_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  src public.ocr_verification_page_jobs_v2%rowtype;
  v_inventory_job uuid;
  v_recovery_job uuid;
  v_articles jsonb;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id = p_job_id;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at < now() then raise exception 'ocr_consensus_v11_lease_invalid'; end if;
  select * into src from public.ocr_verification_page_jobs_v2 where id = j.source_job_id;
  if not found then raise exception 'ocr_consensus_v11_source_job_missing'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2 = 'passed' and fg.freeze_receipt_id = src.freeze_receipt_id) then raise exception 'ocr_consensus_v11_freeze_stale'; end if;

  select rec.inventory_job_id into v_inventory_job from public.source_region_materialization_receipts_v6 rec where rec.partition_job_id = src.partition_job_id;
  if v_inventory_job is null then raise exception 'ocr_consensus_v11_materialization_missing'; end if;
  select ocrrec.job_id into v_recovery_job
  from public.source_page_article_inventory_jobs_v1 ij
  join public.source_page_ocr_recovery_receipts_v1 ocrrec
    on ocrrec.page_identity_source_image_id = ij.page_identity_source_image_id
   and ocrrec.source_image_id = ij.inventory_source_image_id
   and ocrrec.recovered_ocr_fingerprint = ij.source_ocr_json_sha256
   and ocrrec.status = 'passed'
  where ij.id = v_inventory_job;
  if v_recovery_job is null then raise exception 'ocr_consensus_v11_recovery_blocks_missing'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'article_id', g.article_id,
    'source_region_id', g.source_region_id,
    'region_quality_status', g.region_quality_status,
    'crop_version', c.crop_version,
    'crop_spec_sha256', c.crop_spec_sha256,
    'crop_image_sha256', c.crop_image_sha256,
    'google_text', c.crop_ocr_text,
    'google_text_sha256', c.crop_ocr_text_sha256,
    'source_mode', c.source_mode,
    'source_image_sha256', c.source_image_sha256,
    'block_rects', (
      select jsonb_agg(jsonb_build_object('block_index', b.block_index, 'x_min', b.x_min, 'y_min', b.y_min, 'x_max', b.x_max, 'y_max', b.y_max) order by b.block_index)
      from public.source_inventory_block_assignments_v7 a
      join public.source_page_ocr_recovery_fresh_blocks_v1 b on b.job_id = v_recovery_job and b.block_index = a.block_index
      where a.inventory_job_id = v_inventory_job and a.article_id = g.article_id and a.assignment_kind = 'article' and a.assignment_version = g.block_partition_version
    )
  ) order by g.article_id::text), '[]'::jsonb) into v_articles
  from public.ocr_grounded_articles_for_partition_v1(src.partition_job_id) g
  join public.ocr_verification_crop_ocr_v4 c on c.job_id = src.id and c.article_id = g.article_id and c.crop_version = 'article_geometry_mask_composite_v3';

  if jsonb_array_length(v_articles) <> j.article_count then raise exception 'ocr_consensus_v11_article_set_stale'; end if;
  if exists(select 1 from jsonb_array_elements(v_articles) x where jsonb_typeof(x->'block_rects') <> 'array' or jsonb_array_length(x->'block_rects') = 0) then raise exception 'ocr_consensus_v11_block_rects_missing'; end if;

  return jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'source_job_id', j.source_job_id, 'lease_token', j.lease_token, 'article_count', j.article_count, 'is_canary', j.is_canary),
    'source', (select jsonb_build_object('id', s.id, 'storage_path', s.storage_path, 'mime_type', s.mime_type, 'width', s.width, 'height', s.height, 'file_name', s.file_name) from public.source_images s where s.id = src.evidence_source_image_id),
    'articles', v_articles
  );
end
$function$;

revoke all on function public.get_ocr_consensus_page_input_v11(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_ocr_consensus_page_input_v11(uuid, uuid) to postgres, service_role;

create or replace function public.append_ocr_independent_pass_v11(
  p_job_id uuid, p_lease_token uuid, p_pass_kind text, p_chunk_index integer, p_model text,
  p_provider_response_id text, p_prompt_sha256 text, p_response_sha256 text, p_input_binding_sha256 text, p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_source_job uuid;
  v_count integer;
  v_fp text;
  v_binding text;
  v_run_id uuid;
  v_existing_model text;
  r jsonb;
begin
  if p_pass_kind not in ('sol','terra') or p_chunk_index < 0 then raise exception 'ocr_consensus_v11_bad_chunk'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 4 then raise exception 'ocr_consensus_v11_rows_invalid'; end if;
  if coalesce(p_model,'') = '' or coalesce(p_provider_response_id,'') = '' then raise exception 'ocr_consensus_v11_provider_receipt_missing'; end if;
  if coalesce(p_prompt_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_response_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_input_binding_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'ocr_consensus_v11_receipt_hash_invalid'; end if;

  select * into j from public.ocr_consensus_jobs_v11 where id = p_job_id for update;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at < now() then raise exception 'ocr_consensus_v11_lease_invalid'; end if;
  v_source_job := j.source_job_id;

  select model into v_existing_model from public.ocr_independent_pass_runs_v11 where job_id = j.id and pass_kind = p_pass_kind limit 1;
  if v_existing_model is not null and v_existing_model <> p_model then raise exception 'ocr_consensus_v11_model_changed_within_pass'; end if;
  if exists(select 1 from public.ocr_independent_pass_runs_v11 where job_id = j.id and pass_kind <> p_pass_kind and model = p_model) then raise exception 'ocr_consensus_v11_independent_model_required'; end if;
  if exists(select 1 from public.ocr_independent_pass_runs_v11 where provider_response_id = p_provider_response_id or prompt_sha256 = p_prompt_sha256) then raise exception 'ocr_consensus_v11_independent_receipt_required'; end if;

  if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid, transcription text, confidence numeric, proper_noun_status text, visual_proper_nouns text[], output_contract_status text, reason text) group by article_id having count(*) > 1) then raise exception 'ocr_consensus_v11_duplicate_article'; end if;
  if exists(
    select 1 from jsonb_to_recordset(p_rows) x(article_id uuid, transcription text, confidence numeric, proper_noun_status text, visual_proper_nouns text[], output_contract_status text, reason text)
    where not exists(select 1 from public.ocr_verification_crop_ocr_v4 c where c.job_id = v_source_job and c.crop_version = 'article_geometry_mask_composite_v3' and c.article_id = x.article_id)
  ) then raise exception 'ocr_consensus_v11_unknown_article'; end if;
  if exists(
    select 1 from jsonb_to_recordset(p_rows) x(article_id uuid, transcription text, confidence numeric, proper_noun_status text, visual_proper_nouns text[], output_contract_status text, reason text)
    where exists(select 1 from public.ocr_independent_transcriptions_v11 t where t.job_id = j.id and t.pass_kind = p_pass_kind and t.article_id = x.article_id)
  ) then raise exception 'ocr_consensus_v11_article_already_transcribed'; end if;

  select count(*)::int,
         encode(extensions.digest(convert_to(string_agg(x.article_id::text, '|' order by x.article_id::text), 'UTF8'), 'sha256'), 'hex'),
         encode(extensions.digest(convert_to(string_agg(x.article_id::text || ':' || c.crop_spec_sha256 || ':' || c.crop_image_sha256 || ':' || c.source_mode || ':' || c.source_image_sha256, '|' order by x.article_id::text), 'UTF8'), 'sha256'), 'hex')
    into v_count, v_fp, v_binding
  from jsonb_to_recordset(p_rows) x(article_id uuid, transcription text, confidence numeric, proper_noun_status text, visual_proper_nouns text[], output_contract_status text, reason text)
  join public.ocr_verification_crop_ocr_v4 c on c.job_id = v_source_job and c.crop_version = 'article_geometry_mask_composite_v3' and c.article_id = x.article_id;
  if v_count <> jsonb_array_length(p_rows) or v_binding is distinct from p_input_binding_sha256 then raise exception 'ocr_consensus_v11_input_binding_mismatch'; end if;

  insert into public.ocr_independent_pass_runs_v11(job_id, pass_kind, chunk_index, model, provider_response_id, prompt_sha256, response_sha256, input_binding_sha256, article_set_fingerprint, article_count)
  values(j.id, p_pass_kind, p_chunk_index, p_model, p_provider_response_id, p_prompt_sha256, p_response_sha256, p_input_binding_sha256, v_fp, v_count)
  returning id into v_run_id;

  for r in select value from jsonb_array_elements(p_rows) loop
    if coalesce(btrim(r->>'transcription'), '') = '' then raise exception 'ocr_consensus_v11_empty_transcription'; end if;
    if coalesce((r->>'confidence')::numeric, -1) not between 0 and 1 then raise exception 'ocr_consensus_v11_confidence_invalid'; end if;
    if coalesce(r->>'proper_noun_status', '') not in ('passed','not_applicable','failed') then raise exception 'ocr_consensus_v11_proper_noun_status_invalid'; end if;
    if coalesce(r->>'output_contract_status', '') not in ('passed','failed') then raise exception 'ocr_consensus_v11_output_contract_status_invalid'; end if;
    insert into public.ocr_independent_transcriptions_v11(job_id, pass_kind, article_id, transcription, transcription_sha256, confidence, proper_noun_status, visual_proper_nouns, output_contract_status, reason, pass_run_id)
    values(j.id, p_pass_kind, (r->>'article_id')::uuid, r->>'transcription', encode(extensions.digest(convert_to(r->>'transcription', 'UTF8'), 'sha256'), 'hex'), (r->>'confidence')::numeric, r->>'proper_noun_status', coalesce(array(select jsonb_array_elements_text(coalesce(r->'visual_proper_nouns', '[]'::jsonb))), '{}'::text[]), r->>'output_contract_status', left(coalesce(r->>'reason', ''), 1500), v_run_id);
  end loop;

  return jsonb_build_object('status', 'stored', 'run_id', v_run_id, 'pass_kind', p_pass_kind, 'chunk_rows', v_count, 'input_binding_sha256', v_binding);
end
$function$;

revoke all on function public.append_ocr_independent_pass_v11(uuid, uuid, text, integer, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.append_ocr_independent_pass_v11(uuid, uuid, text, integer, text, text, text, text, text, jsonb) to postgres, service_role;

-- decide_ocr_consensus_article_v11: the single/two-model consensus gate.
-- Do not lower these thresholds:
--   single-pass requires region_quality_status='strong' AND sol_confidence>=0.95
--     AND sol_output_contract_status='passed' AND sol_proper_noun_status<>'failed'
--     AND google_sol_similarity>=0.97 AND google_sol_numeric_equal=true.
--   two-model requires sol/terra confidence>=0.88, both output contracts 'passed',
--     both proper_noun_status<>'failed', sol_terra_similarity>=0.96,
--     sol_terra_numeric_equal=true, sol_terra_proper_noun_agreement=true.
--   Anything else is needs_review and never produces a canonical receipt.
create or replace function public.decide_ocr_consensus_article_v11(p_job_id uuid, p_lease_token uuid, p_article_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  e public.ocr_consensus_evidence_v11%rowtype;
  v_status text;
  v_reason text;
  v_selected text;
  v_text text;
  v_text_sha text;
  v_source_legacy uuid;
  v_region_quality text;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id = p_job_id for update;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at < now() then
    raise exception 'ocr_consensus_v11_lease_invalid';
  end if;

  if exists(select 1 from public.ocr_consensus_decisions_v11 where job_id = j.id and article_id = p_article_id) then
    return (select jsonb_build_object('status', decision_status, 'article_id', article_id, 'existing', true)
            from public.ocr_consensus_decisions_v11 where job_id = j.id and article_id = p_article_id);
  end if;

  select * into e from public.ocr_consensus_evidence_v11 where job_id = j.id and article_id = p_article_id;
  if not found or e.sol_text is null then
    return jsonb_build_object('status', 'sol_required', 'article_id', p_article_id);
  end if;

  select g.region_quality_status into v_region_quality
  from public.ocr_verification_page_jobs_v2 src
  cross join lateral public.ocr_grounded_articles_for_partition_v1(src.partition_job_id) g
  where src.id = j.source_job_id and g.article_id = p_article_id
  limit 1;
  if v_region_quality is null then
    raise exception 'ocr_consensus_v11_region_quality_missing';
  end if;

  if v_region_quality = 'strong'
     and e.sol_confidence >= 0.95
     and e.sol_output_contract_status = 'passed'
     and e.sol_proper_noun_status <> 'failed'
     and coalesce(e.google_sol_similarity, 0) >= 0.97
     and e.google_sol_numeric_equal is true then
    v_status := 'passed_single';
    v_selected := 'sol';
    v_text := e.sol_text;
    v_text_sha := e.sol_text_sha256;
    v_reason := format('strict single-pass independent consensus: region=%s sol_conf=%s google_sol_sim=%s numeric_equal=true', v_region_quality, e.sol_confidence, round(e.google_sol_similarity::numeric, 4));
  elsif e.terra_text is null then
    return jsonb_build_object('status', 'terra_required', 'article_id', p_article_id, 'region_quality_status', v_region_quality, 'sol_confidence', e.sol_confidence, 'google_sol_similarity', e.google_sol_similarity, 'google_sol_numeric_equal', e.google_sol_numeric_equal);
  elsif e.sol_confidence >= 0.88
     and e.terra_confidence >= 0.88
     and e.sol_output_contract_status = 'passed'
     and e.terra_output_contract_status = 'passed'
     and e.sol_proper_noun_status <> 'failed'
     and e.terra_proper_noun_status <> 'failed'
     and coalesce(e.sol_terra_similarity, 0) >= 0.96
     and e.sol_terra_numeric_equal is true
     and e.sol_terra_proper_noun_agreement is true then
    v_status := 'passed_two_model';
    v_selected := 'sol';
    v_text := e.sol_text;
    v_text_sha := e.sol_text_sha256;
    v_reason := format('two-model independent consensus: region=%s sol_conf=%s terra_conf=%s sol_terra_sim=%s numeric_equal=true proper_nouns_agree=true', v_region_quality, e.sol_confidence, e.terra_confidence, round(e.sol_terra_similarity::numeric, 4));
  else
    v_status := 'needs_review';
    v_selected := null;
    v_text := null;
    v_text_sha := null;
    v_reason := format('independent consensus failed: region=%s sol_conf=%s terra_conf=%s google_sol_sim=%s google_terra_sim=%s sol_terra_sim=%s google_sol_numeric=%s google_terra_numeric=%s sol_terra_numeric=%s proper_nouns_agree=%s sol_contract=%s terra_contract=%s',
      v_region_quality, e.sol_confidence, e.terra_confidence, round(coalesce(e.google_sol_similarity, 0)::numeric, 4), round(coalesce(e.google_terra_similarity, 0)::numeric, 4), round(coalesce(e.sol_terra_similarity, 0)::numeric, 4),
      coalesce(e.google_sol_numeric_equal, false), coalesce(e.google_terra_numeric_equal, false), coalesce(e.sol_terra_numeric_equal, false), coalesce(e.sol_terra_proper_noun_agreement, false), e.sol_output_contract_status, e.terra_output_contract_status);
  end if;

  insert into public.ocr_consensus_decisions_v11(job_id, article_id, decision_status, selected_source, canonical_text, canonical_text_sha256, google_sol_similarity, google_terra_similarity, sol_terra_similarity, google_sol_numeric_equal, google_terra_numeric_equal, sol_terra_numeric_equal, sol_terra_proper_noun_agreement, decision_reason)
  values(j.id, p_article_id, v_status, v_selected, v_text, v_text_sha, e.google_sol_similarity, e.google_terra_similarity, e.sol_terra_similarity, e.google_sol_numeric_equal, e.google_terra_numeric_equal, e.sol_terra_numeric_equal, e.sol_terra_proper_noun_agreement, v_reason);

  if v_status like 'passed_%' then
    select source_job_id into v_source_legacy from public.ocr_consensus_jobs_v11 where id = j.id;
    insert into public.article_ocr_verifications_v11(article_id, source_consensus_job_id, source_legacy_job_id, canonical_text, canonical_text_sha256, selected_source, google_crop_text_sha256, sol_text_sha256, terra_text_sha256, quality_reason)
    values(p_article_id, j.id, v_source_legacy, v_text, v_text_sha, v_selected, e.google_text_sha256, e.sol_text_sha256, e.terra_text_sha256, v_reason)
    on conflict(article_id) do update set
      source_consensus_job_id = excluded.source_consensus_job_id,
      source_legacy_job_id = excluded.source_legacy_job_id,
      canonical_text = excluded.canonical_text,
      canonical_text_sha256 = excluded.canonical_text_sha256,
      selected_source = excluded.selected_source,
      google_crop_text_sha256 = excluded.google_crop_text_sha256,
      sol_text_sha256 = excluded.sol_text_sha256,
      terra_text_sha256 = excluded.terra_text_sha256,
      quality_reason = excluded.quality_reason,
      verified_at = now(),
      updated_at = now();
  end if;

  return jsonb_build_object('status', v_status, 'article_id', p_article_id, 'selected_source', v_selected, 'region_quality_status', v_region_quality, 'reason', v_reason);
end
$function$;

revoke all on function public.decide_ocr_consensus_article_v11(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.decide_ocr_consensus_article_v11(uuid, uuid, uuid) to postgres, service_role;

create or replace function public.yield_ocr_consensus_job_v11(p_job_id uuid, p_lease_token uuid, p_stage text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if not exists(select 1 from public.ocr_consensus_jobs_v11 where id = p_job_id and status = 'running' and lease_token = p_lease_token and lease_expires_at > now()) then raise exception 'ocr_consensus_v11_lease_invalid'; end if;
  update public.ocr_consensus_jobs_v11 set status = 'queued', lease_token = null, lease_expires_at = null, error_message = null, updated_at = now() where id = p_job_id;
  return jsonb_build_object('status', 'queued', 'completed_stage', left(coalesce(p_stage, ''), 100));
end
$function$;

revoke all on function public.yield_ocr_consensus_job_v11(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.yield_ocr_consensus_job_v11(uuid, uuid, text) to postgres, service_role;

create or replace function public.finish_ocr_consensus_job_v11(p_job_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_total integer;
  v_bad integer;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id = p_job_id for update;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at < now() then raise exception 'ocr_consensus_v11_lease_invalid'; end if;
  select count(*)::int, count(*) filter(where decision_status = 'needs_review')::int into v_total, v_bad from public.ocr_consensus_decisions_v11 where job_id = j.id;
  if v_total <> j.article_count then raise exception 'ocr_consensus_v11_decisions_incomplete'; end if;
  if v_bad > 0 then
    update public.ocr_consensus_jobs_v11 set status = 'needs_review', lease_token = null, lease_expires_at = null, error_message = format('independent OCR consensus needs review: bad_articles=%s', v_bad), finished_at = now(), updated_at = now() where id = j.id;
    return jsonb_build_object('status', 'needs_review', 'bad_articles', v_bad, 'article_count', v_total);
  end if;
  if (select count(*) from public.article_ocr_verifications_v11 where source_consensus_job_id = j.id) <> j.article_count then raise exception 'ocr_consensus_v11_canonical_receipts_incomplete'; end if;
  update public.ocr_consensus_jobs_v11 set status = 'completed', lease_token = null, lease_expires_at = null, error_message = null, finished_at = now(), updated_at = now() where id = j.id;
  return jsonb_build_object('status', 'completed', 'article_count', v_total);
end
$function$;

revoke all on function public.finish_ocr_consensus_job_v11(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_ocr_consensus_job_v11(uuid, uuid) to postgres, service_role;

create or replace function public.fail_ocr_consensus_job_v11(p_job_id uuid, p_lease_token uuid, p_error text, p_retryable boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_failures integer;
  v_status text;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id = p_job_id for update;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease_token then raise exception 'ocr_consensus_v11_lease_invalid'; end if;
  v_failures := j.failure_count + 1;
  v_status := case when p_retryable and v_failures < 4 then 'queued' else 'failed' end;
  update public.ocr_consensus_jobs_v11 set status = v_status, failure_count = v_failures, lease_token = null, lease_expires_at = null, error_message = left(coalesce(p_error, ''), 3000), finished_at = case when v_status = 'failed' then now() else null end, updated_at = now() where id = j.id;
  return jsonb_build_object('status', v_status, 'failure_count', v_failures, 'retry_scheduled', v_status = 'queued');
end
$function$;

revoke all on function public.fail_ocr_consensus_job_v11(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.fail_ocr_consensus_job_v11(uuid, uuid, text, boolean) to postgres, service_role;

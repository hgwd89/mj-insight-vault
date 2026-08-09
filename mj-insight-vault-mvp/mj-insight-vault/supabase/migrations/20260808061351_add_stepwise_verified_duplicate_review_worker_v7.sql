begin;

alter table public.source_grounded_duplicate_review_passes_v5
  add column if not exists decision_confidence numeric;
do $do$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.source_grounded_duplicate_review_passes_v5'::regclass
      and conname='source_grounded_duplicate_review_passes_v5_confidence_check'
  ) then
    alter table public.source_grounded_duplicate_review_passes_v5
      add constraint source_grounded_duplicate_review_passes_v5_confidence_check
      check(decision_confidence is null or decision_confidence between 0 and 1);
  end if;
end $do$;

create table if not exists public.source_grounded_duplicate_review_jobs_v7(
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  article_id_a uuid not null,
  article_id_b uuid not null,
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  active_pass_kind text check(active_pass_kind is null or active_pass_kind in ('reviewer','critic')),
  failure_count integer not null default 0 check(failure_count>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(run_id,article_id_a,article_id_b),
  constraint source_grounded_duplicate_review_jobs_v7_pair_fkey
    foreign key(run_id,article_id_a,article_id_b)
    references public.source_grounded_duplicate_candidates_v5(run_id,article_id_a,article_id_b)
    on delete cascade,
  check(article_id_a<article_id_b)
);
alter table public.source_grounded_duplicate_review_jobs_v7 enable row level security;
revoke all on public.source_grounded_duplicate_review_jobs_v7 from public,anon,authenticated,service_role;
grant select on public.source_grounded_duplicate_review_jobs_v7 to service_role;
create index if not exists source_grounded_duplicate_review_jobs_v7_status_idx
  on public.source_grounded_duplicate_review_jobs_v7(status,created_at);
create index if not exists source_grounded_duplicate_review_jobs_v7_run_idx
  on public.source_grounded_duplicate_review_jobs_v7(run_id,status);

create or replace function public.sync_source_grounded_duplicate_review_job_v7()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_detection text;
begin
  select detection_version into v_detection from public.source_grounded_duplicate_audit_runs_v5 where id=new.run_id;
  if v_detection='verified_ocr_duplicate_audit_v6' then
    insert into public.source_grounded_duplicate_review_jobs_v7(run_id,article_id_a,article_id_b)
    values(new.run_id,new.article_id_a,new.article_id_b)
    on conflict(run_id,article_id_a,article_id_b) do nothing;
  end if;
  return new;
end
$function$;
revoke all on function public.sync_source_grounded_duplicate_review_job_v7() from public,anon,authenticated,service_role;

drop trigger if exists trg_sync_source_grounded_duplicate_review_job_v7 on public.source_grounded_duplicate_candidates_v5;
create trigger trg_sync_source_grounded_duplicate_review_job_v7
after insert on public.source_grounded_duplicate_candidates_v5
for each row execute function public.sync_source_grounded_duplicate_review_job_v7();

create or replace function public.claim_source_grounded_duplicate_review_job_v7(p_lease_seconds integer default 240)
returns setof public.source_grounded_duplicate_review_jobs_v7
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_status text;v_token uuid:=gen_random_uuid();v_pass text;
begin
  if (select embedding_gate from public.article_embedding_quality_gate_v5)<>'passed' then
    raise exception 'duplicate_review_v7_verified_embeddings_required';
  end if;

  insert into public.source_grounded_duplicate_review_jobs_v7(run_id,article_id_a,article_id_b)
  select c.run_id,c.article_id_a,c.article_id_b
  from public.source_grounded_duplicate_candidates_v5 c
  join public.source_grounded_duplicate_audit_runs_v5 r on r.id=c.run_id
  where r.detection_version='verified_ocr_duplicate_audit_v6' and r.status='reviewing'
  on conflict(run_id,article_id_a,article_id_b) do nothing;

  update public.source_grounded_duplicate_review_jobs_v7 j
     set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=coalesce(finished_at,now()),updated_at=now()
   where status in ('queued','running')
     and exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='reviewer')
     and exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='critic');

  update public.source_grounded_duplicate_review_jobs_v7
     set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='duplicate review lease expired too many times',finished_at=now(),updated_at=now()
   where status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;

  select j.id,j.status,
         case
           when not exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='reviewer') then 'reviewer'
           when not exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='critic') then 'critic'
           else null
         end
    into v_id,v_status,v_pass
  from public.source_grounded_duplicate_review_jobs_v7 j
  join public.source_grounded_duplicate_audit_runs_v5 r on r.id=j.run_id and r.status='reviewing' and r.detection_version='verified_ocr_duplicate_audit_v6'
  join public.source_grounded_duplicate_candidates_v5 c on c.run_id=j.run_id and c.article_id_a=j.article_id_a and c.article_id_b=j.article_id_b
  where (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
    and j.failure_count<4
    and (
      not exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='reviewer')
      or not exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='critic')
    )
  order by c.semantic_similarity desc nulls last,c.headline_similarity desc nulls last,j.created_at
  for update of j skip locked
  limit 1;

  if v_id is null or v_pass is null then return; end if;
  update public.source_grounded_duplicate_review_jobs_v7
     set status='running',active_pass_kind=v_pass,lease_token=v_token,
         lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),
         failure_count=failure_count+case when v_status='running' then 1 else 0 end,
         error_message=null,updated_at=now()
   where id=v_id;
  return query select * from public.source_grounded_duplicate_review_jobs_v7 where id=v_id;
end
$function$;

create or replace function public.get_source_grounded_duplicate_review_input_v7(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare j public.source_grounded_duplicate_review_jobs_v7%rowtype;r public.source_grounded_duplicate_audit_runs_v5%rowtype;v_a record;v_b record;v_ocr public.verified_ocr_corpus_receipts_v5%rowtype;v_emb record;
begin
  select * into j from public.source_grounded_duplicate_review_jobs_v7 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'duplicate_review_v7_lease_invalid'; end if;
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=j.run_id;
  if not found or r.status<>'reviewing' or r.detection_version<>'verified_ocr_duplicate_audit_v6' then raise exception 'duplicate_review_v7_run_not_reviewing'; end if;
  select * into v_ocr from public.current_verified_ocr_corpus_receipt_v5;
  select * into v_emb from public.verified_embedding_set_fingerprint_v6();
  if v_ocr.id is distinct from r.ocr_receipt_id or v_ocr.verification_set_fingerprint is distinct from r.ocr_verification_set_fingerprint or v_emb.embedding_set_fingerprint is distinct from r.embedding_set_fingerprint then raise exception 'duplicate_review_v7_input_stale'; end if;
  select article_id,analysis_text,analysis_text_sha256 into v_a from public.formal_verified_article_text_v5 where article_id=j.article_id_a;
  select article_id,analysis_text,analysis_text_sha256 into v_b from public.formal_verified_article_text_v5 where article_id=j.article_id_b;
  if v_a.article_id is null or v_b.article_id is null or coalesce(v_a.analysis_text,'')='' or coalesce(v_b.analysis_text,'')='' then raise exception 'duplicate_review_v7_verified_text_missing'; end if;
  return jsonb_build_object(
    'job',jsonb_build_object('id',j.id,'run_id',j.run_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token),
    'article_a',jsonb_build_object('article_id',j.article_id_a,'verified_text',v_a.analysis_text,'verified_text_sha256',v_a.analysis_text_sha256),
    'article_b',jsonb_build_object('article_id',j.article_id_b,'verified_text',v_b.analysis_text,'verified_text_sha256',v_b.analysis_text_sha256)
  );
end
$function$;

create or replace function public.store_source_grounded_duplicate_review_v7(
  p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,
  p_disposition text,p_confidence numeric,p_reason text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare j public.source_grounded_duplicate_review_jobs_v7%rowtype;r public.source_grounded_duplicate_audit_runs_v5%rowtype;v_other public.source_grounded_duplicate_review_passes_v5%rowtype;v_a_len integer;v_b_len integer;v_canonical uuid;v_next text;
begin
  select * into j from public.source_grounded_duplicate_review_jobs_v7 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'duplicate_review_v7_lease_invalid'; end if;
  if j.active_pass_kind is distinct from p_pass_kind or p_pass_kind not in ('reviewer','critic') then raise exception 'duplicate_review_v7_pass_kind_invalid'; end if;
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=j.run_id;
  if not found or r.status<>'reviewing' or r.detection_version<>'verified_ocr_duplicate_audit_v6' then raise exception 'duplicate_review_v7_run_not_reviewing'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'duplicate_review_v7_receipt_invalid'; end if;
  if p_disposition not in ('distinct','duplicate','unresolved') then raise exception 'duplicate_review_v7_disposition_invalid'; end if;
  if p_confidence is null or p_confidence<0 or p_confidence>1 then raise exception 'duplicate_review_v7_confidence_invalid'; end if;
  if p_disposition<>'unresolved' and p_confidence<0.85 then raise exception 'duplicate_review_v7_confidence_too_low'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'duplicate_review_v7_reason_required'; end if;
  if not exists(select 1 from public.source_grounded_duplicate_candidates_v5 c where c.run_id=j.run_id and c.article_id_a=j.article_id_a and c.article_id_b=j.article_id_b) then raise exception 'duplicate_review_v7_candidate_missing'; end if;

  select * into v_other from public.source_grounded_duplicate_review_passes_v5
  where run_id=j.run_id and article_id_a=j.article_id_a and article_id_b=j.article_id_b and pass_kind<>p_pass_kind;
  if found and (v_other.model=p_model or v_other.provider_response_id=p_provider_response_id or v_other.prompt_sha256=p_prompt_sha256) then raise exception 'duplicate_review_v7_independent_pass_required'; end if;

  if p_disposition='duplicate' then
    select char_length(analysis_text) into v_a_len from public.formal_verified_article_text_v5 where article_id=j.article_id_a;
    select char_length(analysis_text) into v_b_len from public.formal_verified_article_text_v5 where article_id=j.article_id_b;
    if v_a_len is null or v_b_len is null then raise exception 'duplicate_review_v7_verified_text_missing'; end if;
    v_canonical:=case when v_a_len>v_b_len then j.article_id_a when v_b_len>v_a_len then j.article_id_b when j.article_id_a::text<j.article_id_b::text then j.article_id_a else j.article_id_b end;
  else
    v_canonical:=null;
  end if;

  insert into public.source_grounded_duplicate_review_passes_v5(
    run_id,article_id_a,article_id_b,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,disposition,canonical_article_id,reason,decision_confidence,updated_at
  ) values(
    j.run_id,j.article_id_a,j.article_id_b,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_disposition,v_canonical,left(p_reason,1500),p_confidence,now()
  )
  on conflict(run_id,article_id_a,article_id_b,pass_kind) do update set
    model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,
    disposition=excluded.disposition,canonical_article_id=excluded.canonical_article_id,reason=excluded.reason,decision_confidence=excluded.decision_confidence,updated_at=now();

  v_next:=case when
    exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='reviewer')
    and exists(select 1 from public.source_grounded_duplicate_review_passes_v5 p where p.run_id=j.run_id and p.article_id_a=j.article_id_a and p.article_id_b=j.article_id_b and p.pass_kind='critic')
    then 'completed' else 'queued' end;
  update public.source_grounded_duplicate_review_jobs_v7
     set status=v_next,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,
         finished_at=case when v_next='completed' then now() else null end,updated_at=now()
   where id=j.id;
  return jsonb_build_object('status',v_next,'pass_kind',p_pass_kind,'disposition',p_disposition,'confidence',p_confidence,'canonical_article_id',v_canonical);
end
$function$;

create or replace function public.fail_source_grounded_duplicate_review_job_v7(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare j public.source_grounded_duplicate_review_jobs_v7%rowtype;v_failures integer;v_next text;
begin
  select * into j from public.source_grounded_duplicate_review_jobs_v7 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'duplicate_review_v7_lease_invalid'; end if;
  v_failures:=j.failure_count+1;
  v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_failures<4 then 'queued' else 'failed' end;
  update public.source_grounded_duplicate_review_jobs_v7
     set status=v_next,failure_count=v_failures,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'duplicate review worker failed'),3000),
         finished_at=case when v_next='failed' then now() else null end,updated_at=now()
   where id=j.id;
  return jsonb_build_object('status',v_next,'failure_count',v_failures,'retry_scheduled',(v_next='queued'));
end
$function$;

create or replace function public.requeue_source_grounded_duplicate_review_job_v7(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare j public.source_grounded_duplicate_review_jobs_v7%rowtype;
begin
  select * into j from public.source_grounded_duplicate_review_jobs_v7 where id=p_job_id for update;
  if not found or j.status not in ('needs_review','failed') then raise exception 'duplicate_review_v7_requeue_not_allowed'; end if;
  if not exists(select 1 from public.source_grounded_duplicate_audit_runs_v5 r where r.id=j.run_id and r.status='reviewing' and r.detection_version='verified_ocr_duplicate_audit_v6') then raise exception 'duplicate_review_v7_run_not_reviewing'; end if;
  delete from public.source_grounded_duplicate_review_passes_v5 where run_id=j.run_id and article_id_a=j.article_id_a and article_id_b=j.article_id_b;
  update public.source_grounded_duplicate_review_jobs_v7
     set status='queued',active_pass_kind=null,failure_count=0,lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now()
   where id=j.id;
  return jsonb_build_object('status','queued','proofs_reset',true);
end
$function$;

create or replace function public.finalize_source_grounded_duplicate_audit_v7(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare r public.source_grounded_duplicate_audit_runs_v5%rowtype;v_candidates integer;v_jobs integer;v_completed integer;
begin
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=p_run_id;
  if not found or r.status<>'reviewing' or r.detection_version<>'verified_ocr_duplicate_audit_v6' then raise exception 'duplicate_review_v7_run_not_finalizable'; end if;
  select count(*)::integer into v_candidates from public.source_grounded_duplicate_candidates_v5 where run_id=r.id;
  select count(*)::integer,count(*) filter(where status='completed')::integer into v_jobs,v_completed from public.source_grounded_duplicate_review_jobs_v7 where run_id=r.id;
  if v_jobs<>v_candidates or v_completed<>v_candidates then raise exception 'duplicate_review_v7_pair_jobs_incomplete'; end if;
  return public.finalize_source_grounded_duplicate_audit_v6(p_run_id);
end
$function$;

revoke all on function public.claim_source_grounded_duplicate_review_job_v7(integer) from public,anon,authenticated;
revoke all on function public.get_source_grounded_duplicate_review_input_v7(uuid,uuid) from public,anon,authenticated;
revoke all on function public.store_source_grounded_duplicate_review_v7(uuid,uuid,text,text,text,text,text,text,numeric,text) from public,anon,authenticated;
revoke all on function public.fail_source_grounded_duplicate_review_job_v7(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.requeue_source_grounded_duplicate_review_job_v7(uuid) from public,anon,authenticated;
revoke all on function public.finalize_source_grounded_duplicate_audit_v7(uuid) from public,anon,authenticated;
grant execute on function public.claim_source_grounded_duplicate_review_job_v7(integer) to service_role;
grant execute on function public.get_source_grounded_duplicate_review_input_v7(uuid,uuid) to service_role;
grant execute on function public.store_source_grounded_duplicate_review_v7(uuid,uuid,text,text,text,text,text,text,numeric,text) to service_role;
grant execute on function public.fail_source_grounded_duplicate_review_job_v7(uuid,uuid,text,boolean) to service_role;
grant execute on function public.requeue_source_grounded_duplicate_review_job_v7(uuid) to service_role;
grant execute on function public.finalize_source_grounded_duplicate_audit_v7(uuid) to service_role;

commit;
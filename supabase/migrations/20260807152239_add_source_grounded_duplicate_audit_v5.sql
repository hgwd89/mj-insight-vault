create table public.source_grounded_duplicate_audit_runs_v5 (
  id uuid primary key default gen_random_uuid(),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  corpus_article_count integer not null,
  source_grounded_fingerprint text not null check(source_grounded_fingerprint ~ '^[0-9a-f]{64}$'),
  strict_embedding_count integer not null,
  embedding_set_fingerprint text not null check(embedding_set_fingerprint ~ '^[0-9a-f]{64}$'),
  detection_version text not null default 'source_grounded_duplicate_audit_v5',
  status text not null default 'queued' check(status in ('queued','running','reviewing','completed','failed')),
  candidate_count integer not null default 0,
  distinct_count integer not null default 0,
  duplicate_count integer not null default 0,
  unresolved_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique(freeze_receipt_id,source_grounded_fingerprint,embedding_set_fingerprint,detection_version)
);

create table public.source_grounded_duplicate_candidates_v5 (
  run_id uuid not null references public.source_grounded_duplicate_audit_runs_v5(id) on delete cascade,
  article_id_a uuid not null references public.articles(id),
  article_id_b uuid not null references public.articles(id),
  semantic_similarity double precision,
  headline_similarity double precision,
  same_date boolean not null default false,
  same_source_region_hash boolean not null default false,
  same_page_identity boolean not null default false,
  detection_reasons text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  primary key(run_id,article_id_a,article_id_b),
  check(article_id_a < article_id_b)
);

create table public.source_grounded_duplicate_review_passes_v5 (
  run_id uuid not null,
  article_id_a uuid not null,
  article_id_b uuid not null,
  pass_kind text not null check(pass_kind in ('reviewer','critic')),
  model text not null,
  provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  disposition text not null check(disposition in ('distinct','duplicate','unresolved')),
  canonical_article_id uuid references public.articles(id),
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(run_id,article_id_a,article_id_b,pass_kind),
  foreign key(run_id,article_id_a,article_id_b) references public.source_grounded_duplicate_candidates_v5(run_id,article_id_a,article_id_b) on delete cascade,
  check((disposition='duplicate' and canonical_article_id is not null and canonical_article_id in (article_id_a,article_id_b)) or (disposition<>'duplicate' and canonical_article_id is null))
);

create function public.formal_embedding_set_fingerprint_v5()
returns table(embedding_count bigint,embedding_set_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with x as (
  select e.article_id,e.freeze_receipt_id,e.source_region_id,e.source_partition_job_id,e.source_region_sha256,e.source_ocr_sha256,e.embedding_input_sha256,e.embedding_model,e.embedding_version
  from public.formal_article_embeddings_v4 e
), c as (
  select count(*)::bigint n,
         coalesce(string_agg(encode(extensions.digest(convert_to(jsonb_build_array(article_id::text,freeze_receipt_id::text,source_region_id::text,source_partition_job_id::text,source_region_sha256,source_ocr_sha256,embedding_input_sha256,embedding_model,embedding_version)::text,'UTF8'),'sha256'),'hex'),'|' order by article_id::text),'') payload
  from x
)
select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex') from c;
$$;

create function public.create_source_grounded_duplicate_audit_run_v5()
returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_freeze uuid;v_ground record;v_emb record;v_id uuid;
begin
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'duplicate_v5_freeze_v2_required'; end if;
  if (select embedding_gate from public.article_embedding_quality_gate_v4)<>'passed' then raise exception 'duplicate_v5_embedding_v4_required'; end if;
  select * into v_ground from public.formal_source_grounded_scope_proof_v4('all','');
  select * into v_emb from public.formal_embedding_set_fingerprint_v5();
  if v_ground.article_count<=0 or v_emb.embedding_count<>v_ground.article_count then raise exception 'duplicate_v5_embedding_count_mismatch'; end if;
  insert into public.source_grounded_duplicate_audit_runs_v5(freeze_receipt_id,corpus_article_count,source_grounded_fingerprint,strict_embedding_count,embedding_set_fingerprint)
  values(v_freeze,v_ground.article_count,v_ground.source_grounded_fingerprint,v_emb.embedding_count,v_emb.embedding_set_fingerprint)
  on conflict(freeze_receipt_id,source_grounded_fingerprint,embedding_set_fingerprint,detection_version)
  do update set updated_at=now()
  returning id into v_id;
  return v_id;
end $$;

alter table public.source_grounded_duplicate_audit_runs_v5 add column updated_at timestamptz not null default now();

create function public.populate_source_grounded_duplicate_candidates_v5(p_run_id uuid)
returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  r public.source_grounded_duplicate_audit_runs_v5%rowtype;v_ground record;v_emb record;v_count integer;
begin
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=p_run_id for update;
  if not found then raise exception 'duplicate_v5_run_missing'; end if;
  if r.status not in ('queued','running') then raise exception 'duplicate_v5_run_not_populatable'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=r.freeze_receipt_id) then raise exception 'duplicate_v5_freeze_stale'; end if;
  select * into v_ground from public.formal_source_grounded_scope_proof_v4('all','');
  select * into v_emb from public.formal_embedding_set_fingerprint_v5();
  if v_ground.article_count<>r.corpus_article_count or v_ground.source_grounded_fingerprint<>r.source_grounded_fingerprint or v_emb.embedding_count<>r.strict_embedding_count or v_emb.embedding_set_fingerprint<>r.embedding_set_fingerprint then raise exception 'duplicate_v5_input_stale'; end if;

  update public.source_grounded_duplicate_audit_runs_v5 set status='running',started_at=coalesce(started_at,now()),updated_at=now() where id=r.id;
  delete from public.source_grounded_duplicate_review_passes_v5 where run_id=r.id;
  delete from public.source_grounded_duplicate_candidates_v5 where run_id=r.id;

  with e as materialized (
    select e.article_id,e.embedding_vector,g.headline,g.article_date,g.source_region_sha256,g.page_identity_source_image_id
    from public.formal_article_embeddings_v4 e join public.formal_source_grounded_articles_v4 g on g.article_id=e.article_id
  ), nearest as (
    select a.article_id a_id,n.article_id b_id,
           1-(a.embedding_vector <=> n.embedding_vector) semantic_similarity,
           similarity(public.normalize_article_headline_v1(a.headline),public.normalize_article_headline_v1(n.headline)) headline_similarity,
           a.article_date=n.article_date same_date,
           a.source_region_sha256=n.source_region_sha256 same_region,
           a.page_identity_source_image_id=n.page_identity_source_image_id same_page
    from e a
    cross join lateral (
      select b.* from e b where b.article_id<>a.article_id order by a.embedding_vector <=> b.embedding_vector limit 12
    ) n
  ), norm as (
    select least(a_id,b_id) a_id,greatest(a_id,b_id) b_id,max(semantic_similarity) semantic_similarity,max(headline_similarity) headline_similarity,bool_or(same_date) same_date,bool_or(same_region) same_region,bool_or(same_page) same_page
    from nearest group by least(a_id,b_id),greatest(a_id,b_id)
  ), candidates as (
    select *,array_remove(array[
      case when same_region then 'same_source_region_sha' end,
      case when semantic_similarity>=0.985 then 'semantic_ge_0985' end,
      case when semantic_similarity>=0.970 and headline_similarity>=0.25 then 'semantic_ge_097_headline_ge_025' end,
      case when same_date and headline_similarity>=0.55 then 'same_date_headline_ge_055' end
    ],null)::text[] reasons
    from norm
    where same_region or semantic_similarity>=0.985 or (semantic_similarity>=0.970 and headline_similarity>=0.25) or (same_date and headline_similarity>=0.55)
  ), ins as (
    insert into public.source_grounded_duplicate_candidates_v5(run_id,article_id_a,article_id_b,semantic_similarity,headline_similarity,same_date,same_source_region_hash,same_page_identity,detection_reasons)
    select r.id,a_id,b_id,semantic_similarity,headline_similarity,same_date,same_region,same_page,reasons from candidates
    on conflict do nothing returning 1
  ) select count(*)::integer into v_count from ins;

  update public.source_grounded_duplicate_audit_runs_v5 set candidate_count=v_count,status=case when v_count=0 then 'completed' else 'reviewing' end,distinct_count=case when v_count=0 then 0 else distinct_count end,duplicate_count=0,unresolved_count=case when v_count=0 then 0 else v_count end,finished_at=case when v_count=0 then now() else null end,updated_at=now() where id=r.id;
  return v_count;
end $$;

create function public.store_source_grounded_duplicate_review_v5(
  p_run_id uuid,p_article_id_a uuid,p_article_id_b uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_disposition text,p_canonical_article_id uuid,p_reason text
)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  r public.source_grounded_duplicate_audit_runs_v5%rowtype;v_other public.source_grounded_duplicate_review_passes_v5%rowtype;
begin
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=p_run_id;
  if not found or r.status<>'reviewing' then raise exception 'duplicate_v5_run_not_reviewing'; end if;
  if not exists(select 1 from public.source_grounded_duplicate_candidates_v5 c where c.run_id=p_run_id and c.article_id_a=p_article_id_a and c.article_id_b=p_article_id_b) then raise exception 'duplicate_v5_candidate_missing'; end if;
  if p_pass_kind not in ('reviewer','critic') or coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'duplicate_v5_review_receipt_invalid'; end if;
  if p_disposition not in ('distinct','duplicate','unresolved') then raise exception 'duplicate_v5_disposition_invalid'; end if;
  if (p_disposition='duplicate' and p_canonical_article_id not in (p_article_id_a,p_article_id_b)) or (p_disposition<>'duplicate' and p_canonical_article_id is not null) then raise exception 'duplicate_v5_canonical_invalid'; end if;
  select * into v_other from public.source_grounded_duplicate_review_passes_v5 where run_id=p_run_id and article_id_a=p_article_id_a and article_id_b=p_article_id_b and pass_kind<>p_pass_kind;
  if found and (v_other.model=p_model or v_other.provider_response_id=p_provider_response_id or v_other.prompt_sha256=p_prompt_sha256) then raise exception 'duplicate_v5_review_passes_must_be_independent'; end if;

  insert into public.source_grounded_duplicate_review_passes_v5(run_id,article_id_a,article_id_b,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,disposition,canonical_article_id,reason,updated_at)
  values(p_run_id,p_article_id_a,p_article_id_b,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_disposition,p_canonical_article_id,left(coalesce(p_reason,''),1500),now())
  on conflict(run_id,article_id_a,article_id_b,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,disposition=excluded.disposition,canonical_article_id=excluded.canonical_article_id,reason=excluded.reason,updated_at=now();
  return jsonb_build_object('status','stored','pass_kind',p_pass_kind);
end $$;

create function public.finalize_source_grounded_duplicate_audit_v5(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.source_grounded_duplicate_audit_runs_v5%rowtype;v_candidates integer;v_distinct integer;v_duplicate integer;v_unresolved integer;begin
  select * into r from public.source_grounded_duplicate_audit_runs_v5 where id=p_run_id for update;
  if not found or r.status not in ('reviewing','running') then raise exception 'duplicate_v5_run_not_finalizable'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=r.freeze_receipt_id) then raise exception 'duplicate_v5_freeze_stale'; end if;
  select count(*)::integer into v_candidates from public.source_grounded_duplicate_candidates_v5 where run_id=r.id;
  with x as (
    select c.article_id_a,c.article_id_b,
           max(p.disposition) filter(where p.pass_kind='reviewer') reviewer_disp,
           max(p.disposition) filter(where p.pass_kind='critic') critic_disp,
           max(p.canonical_article_id) filter(where p.pass_kind='reviewer') reviewer_canonical,
           max(p.canonical_article_id) filter(where p.pass_kind='critic') critic_canonical,
           count(p.*)::integer pass_count
    from public.source_grounded_duplicate_candidates_v5 c
    left join public.source_grounded_duplicate_review_passes_v5 p using(run_id,article_id_a,article_id_b)
    where c.run_id=r.id group by c.article_id_a,c.article_id_b
  ), classified as (
    select *,case when pass_count<>2 then 'unresolved' when reviewer_disp<>critic_disp then 'unresolved' when reviewer_disp='duplicate' and reviewer_canonical is distinct from critic_canonical then 'unresolved' else reviewer_disp end final_disp from x
  )
  select count(*) filter(where final_disp='distinct')::integer,count(*) filter(where final_disp='duplicate')::integer,count(*) filter(where final_disp='unresolved')::integer
  into v_distinct,v_duplicate,v_unresolved from classified;
  update public.source_grounded_duplicate_audit_runs_v5 set candidate_count=v_candidates,distinct_count=coalesce(v_distinct,0),duplicate_count=coalesce(v_duplicate,0),unresolved_count=coalesce(v_unresolved,0),status='completed',finished_at=now(),updated_at=now() where id=r.id;
  return jsonb_build_object('status','completed','candidate_count',v_candidates,'distinct_count',coalesce(v_distinct,0),'duplicate_count',coalesce(v_duplicate,0),'unresolved_count',coalesce(v_unresolved,0));
end $$;

create view public.formal_corpus_duplicate_gate_v5 as
with p as (select * from public.formal_source_grounded_scope_proof_v4('all','')),
e as (select * from public.article_embedding_quality_gate_v4),ef as (select * from public.formal_embedding_set_fingerprint_v5()),fg as (select * from public.formal_corpus_freeze_gate_v2),current_run as (
  select r.* from public.source_grounded_duplicate_audit_runs_v5 r
  cross join p cross join ef cross join fg
  where r.freeze_receipt_id=fg.freeze_receipt_id and r.corpus_article_count=p.article_count and r.source_grounded_fingerprint=p.source_grounded_fingerprint and r.strict_embedding_count=ef.embedding_count and r.embedding_set_fingerprint=ef.embedding_set_fingerprint and r.detection_version='source_grounded_duplicate_audit_v5'
  order by r.created_at desc limit 1
)
select p.article_count::integer formal_article_count,p.source_grounded_fingerprint,e.strict_embedding_count,e.embedding_gate,r.id audit_run_id,r.status audit_run_status,coalesce(r.candidate_count,0) duplicate_candidate_pair_count,coalesce(r.distinct_count,0) reviewed_distinct_pair_count,coalesce(r.duplicate_count,0) reviewed_duplicate_pair_count,coalesce(r.unresolved_count,0) unresolved_pair_count,
case when fg.freeze_gate_v2<>'passed' then 'failed' when e.embedding_gate<>'passed' then 'failed' when r.id is null then 'failed' when r.status<>'completed' then 'failed' when r.duplicate_count>0 or r.unresolved_count>0 then 'failed' else 'passed' end duplicate_gate,
case when fg.freeze_gate_v2<>'passed' then 'formal_corpus_freeze_v2_required' when e.embedding_gate<>'passed' then 'source_grounded_embedding_required' when r.id is null then 'current_source_grounded_duplicate_audit_required' when r.status<>'completed' then 'duplicate_audit_not_completed' when r.duplicate_count>0 then 'duplicate_candidates_must_be_removed_and_refrozen' when r.unresolved_count>0 then 'duplicate_candidates_require_review' else 'passed' end gate_reason
from p cross join e cross join ef cross join fg left join current_run r on true;

alter table public.source_grounded_duplicate_audit_runs_v5 enable row level security;
alter table public.source_grounded_duplicate_candidates_v5 enable row level security;
alter table public.source_grounded_duplicate_review_passes_v5 enable row level security;
revoke all on table public.source_grounded_duplicate_audit_runs_v5,public.source_grounded_duplicate_candidates_v5,public.source_grounded_duplicate_review_passes_v5 from anon,authenticated,service_role;
grant select on table public.source_grounded_duplicate_audit_runs_v5,public.source_grounded_duplicate_candidates_v5,public.source_grounded_duplicate_review_passes_v5 to service_role;
revoke all on table public.formal_corpus_duplicate_gate_v5 from anon,authenticated;grant select on table public.formal_corpus_duplicate_gate_v5 to service_role;
revoke execute on function public.formal_embedding_set_fingerprint_v5() from public,anon,authenticated;
revoke execute on function public.create_source_grounded_duplicate_audit_run_v5() from public,anon,authenticated;
revoke execute on function public.populate_source_grounded_duplicate_candidates_v5(uuid) from public,anon,authenticated;
revoke execute on function public.store_source_grounded_duplicate_review_v5(uuid,uuid,uuid,text,text,text,text,text,text,uuid,text) from public,anon,authenticated;
revoke execute on function public.finalize_source_grounded_duplicate_audit_v5(uuid) from public,anon,authenticated;
grant execute on function public.formal_embedding_set_fingerprint_v5() to service_role;
grant execute on function public.create_source_grounded_duplicate_audit_run_v5() to service_role;
grant execute on function public.populate_source_grounded_duplicate_candidates_v5(uuid) to service_role;
grant execute on function public.store_source_grounded_duplicate_review_v5(uuid,uuid,uuid,text,text,text,text,text,text,uuid,text) to service_role;
grant execute on function public.finalize_source_grounded_duplicate_audit_v5(uuid) to service_role;
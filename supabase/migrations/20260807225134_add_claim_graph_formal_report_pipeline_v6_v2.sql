create table if not exists public.formal_report_jobs_v6 (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  theme_proof_receipt_id uuid not null references public.theme_analysis_proof_receipts_v6(id) on delete restrict,
  user_query text not null check(length(btrim(user_query))>=2),
  status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed','published')),
  candidate_set_fingerprint text not null check(candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),
  census_identity_fingerprint text not null check(census_identity_fingerprint ~ '^[0-9a-f]{64}$'),
  metrics_fingerprint text not null check(metrics_fingerprint ~ '^[0-9a-f]{64}$'),
  selection_fingerprint text not null check(selection_fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_fingerprint text not null check(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  selected_theme_count integer not null check(selected_theme_count>0),
  attempt_count integer not null default 0 check(attempt_count>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_class text,
  error_message text,
  report_id uuid references public.chat_reports(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.formal_report_pass_runs_v6 (
  id uuid primary key default gen_random_uuid(),
  report_job_id uuid not null references public.formal_report_jobs_v6(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('writer','critic')),
  model text not null check(length(btrim(model))>=2),
  provider_response_id text not null unique check(length(btrim(provider_response_id))>=6),
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(report_job_id,pass_kind)
);

create table if not exists public.formal_report_claims_v6 (
  id uuid primary key default gen_random_uuid(),
  report_job_id uuid not null references public.formal_report_jobs_v6(id) on delete cascade,
  claim_index integer not null check(claim_index>0),
  claim_type text not null check(claim_type in ('observed','inferred','cross_theme_narrative','hypothesis','implication','limitation','research_question')),
  candidate_ids uuid[] not null default '{}'::uuid[],
  claim_text text not null check(length(btrim(claim_text))>=20),
  claim_text_sha256 text not null check(claim_text_sha256 ~ '^[0-9a-f]{64}$'),
  support_article_ids uuid[] not null default '{}'::uuid[],
  counter_article_ids uuid[] not null default '{}'::uuid[],
  caveat text,
  created_at timestamptz not null default now(),
  unique(report_job_id,claim_index)
);

create table if not exists public.formal_report_critic_rows_v6 (
  id uuid primary key default gen_random_uuid(),
  report_job_id uuid not null references public.formal_report_jobs_v6(id) on delete cascade,
  claim_id uuid not null references public.formal_report_claims_v6(id) on delete cascade,
  claim_text_sha256 text not null check(claim_text_sha256 ~ '^[0-9a-f]{64}$'),
  verdict text not null check(verdict in ('supported','rejected','unresolved')),
  evidence_sufficient boolean not null,
  numeric_accuracy boolean not null,
  causal_strength_ok boolean not null,
  scope_ok boolean not null,
  counterevidence_handled boolean not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  unique(report_job_id,claim_id)
);

alter table public.formal_report_jobs_v6 enable row level security;
alter table public.formal_report_pass_runs_v6 enable row level security;
alter table public.formal_report_claims_v6 enable row level security;
alter table public.formal_report_critic_rows_v6 enable row level security;
revoke all on public.formal_report_jobs_v6,public.formal_report_pass_runs_v6,public.formal_report_claims_v6,public.formal_report_critic_rows_v6 from public,anon,authenticated,service_role;

create or replace function public.strict_analysis_prerequisites_pass_v7(p_analysis_run_id uuid)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
select exists(
  select 1 from public.theme_analysis_runs_v4 a
  cross join public.formal_corpus_freeze_gate_v2 f
  cross join public.article_source_region_gate_v4 sr
  cross join public.article_embedding_quality_gate_v4 eg
  cross join public.formal_corpus_duplicate_gate_v5 dg
  cross join public.category_classification_gate_v4 cg
  where a.id=p_analysis_run_id
    and f.freeze_gate_v2='passed'
    and sr.source_region_gate='passed'
    and eg.embedding_gate='passed'
    and dg.duplicate_gate='passed'
    and cg.category_classification_gate='passed'
    and public.full_corpus_run_integrity_v5(a.scan_run_id)
    and public.theme_analysis_proof_integrity_v6(a.id)
);
$$;

create or replace function public.validate_formal_report_claim_v6()
returns trigger
language plpgsql security definer
set search_path=pg_catalog,public,extensions
as $$
declare j public.formal_report_jobs_v6%rowtype;v_pages integer;v_n integer;begin
  select * into j from public.formal_report_jobs_v6 where id=new.report_job_id;
  if not found or j.status<>'running' then raise exception 'report_v6_job_not_running'; end if;
  new.claim_text:=btrim(new.claim_text);
  new.claim_text_sha256:=encode(extensions.digest(convert_to(new.claim_text,'UTF8'),'sha256'),'hex');
  select count(distinct x)::integer into v_n from unnest(new.candidate_ids) x;
  if v_n<>cardinality(new.candidate_ids) then raise exception 'report_v6_duplicate_candidate_ids'; end if;
  select count(distinct x)::integer into v_n from unnest(new.support_article_ids) x;
  if v_n<>cardinality(new.support_article_ids) then raise exception 'report_v6_duplicate_support_ids'; end if;
  select count(distinct x)::integer into v_n from unnest(new.counter_article_ids) x;
  if v_n<>cardinality(new.counter_article_ids) then raise exception 'report_v6_duplicate_counter_ids'; end if;
  if exists(select 1 from unnest(new.support_article_ids) s join unnest(new.counter_article_ids) c on c=s) then raise exception 'report_v6_support_counter_overlap'; end if;
  if new.claim_type in ('observed','inferred','implication','limitation') and cardinality(new.candidate_ids)<1 then raise exception 'report_v6_candidate_required'; end if;
  if new.claim_type='cross_theme_narrative' and cardinality(new.candidate_ids)<2 then raise exception 'report_v6_cross_theme_requires_two_candidates'; end if;
  if exists(select 1 from unnest(new.candidate_ids) x where not exists(select 1 from public.theme_major_selection_v6 s where s.analysis_run_id=j.analysis_run_id and s.candidate_id=x and s.selected_for_report)) then raise exception 'report_v6_unselected_candidate'; end if;
  if exists(select 1 from unnest(new.support_article_ids) x where not exists(select 1 from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id and e.article_id=x and e.relation='support' and e.candidate_id=any(new.candidate_ids))) then raise exception 'report_v6_support_not_deterministic_evidence'; end if;
  if exists(select 1 from unnest(new.counter_article_ids) x where not exists(select 1 from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=j.analysis_run_id and e.article_id=x and e.relation='counter' and e.candidate_id=any(new.candidate_ids))) then raise exception 'report_v6_counter_not_deterministic_evidence'; end if;
  if new.claim_type='observed' and cardinality(new.support_article_ids)<1 then raise exception 'report_v6_observed_support_required'; end if;
  if new.claim_type in ('inferred','implication','cross_theme_narrative') then
    if cardinality(new.support_article_ids)<2 then raise exception 'report_v6_multi_evidence_required'; end if;
    select count(distinct g.page_identity_source_image_id)::integer into v_pages from unnest(new.support_article_ids) x join public.formal_source_grounded_articles_v4 g on g.article_id=x;
    if v_pages<2 then raise exception 'report_v6_multi_page_support_required'; end if;
  end if;
  if new.claim_type='limitation' and length(btrim(coalesce(new.caveat,'')))<8 then raise exception 'report_v6_limitation_caveat_required'; end if;
  return new;
end $$;

drop trigger if exists trg_validate_formal_report_claim_v6 on public.formal_report_claims_v6;
create trigger trg_validate_formal_report_claim_v6 before insert or update on public.formal_report_claims_v6 for each row execute function public.validate_formal_report_claim_v6();

create or replace function public.create_formal_report_job_v6(p_analysis_run_id uuid,p_user_query text)
returns uuid
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare p public.theme_analysis_proof_receipts_v6%rowtype;v_id uuid;begin
  if not public.strict_analysis_prerequisites_pass_v7(p_analysis_run_id) then raise exception 'report_v6_strict_prerequisites_not_ready'; end if;
  select * into p from public.theme_analysis_proof_receipts_v6 where analysis_run_id=p_analysis_run_id;
  if not found or not public.theme_analysis_proof_integrity_v6(p_analysis_run_id) or p.selected_theme_count<1 then raise exception 'report_v6_theme_proof_invalid_or_empty'; end if;
  insert into public.formal_report_jobs_v6(analysis_run_id,theme_proof_receipt_id,user_query,candidate_set_fingerprint,census_identity_fingerprint,metrics_fingerprint,selection_fingerprint,evidence_fingerprint,selected_theme_count)
  values(p_analysis_run_id,p.id,btrim(p_user_query),p.candidate_set_fingerprint,p.census_identity_fingerprint,p.metrics_fingerprint,p.selection_fingerprint,p.evidence_fingerprint,p.selected_theme_count)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.claim_formal_report_job_v6(p_lease_seconds integer default 420)
returns setof public.formal_report_jobs_v6
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();begin
  select j.id into v_id from public.formal_report_jobs_v6 j
  where (j.status='queued' or (j.status='running' and (j.lease_expires_at is null or j.lease_expires_at<now())))
    and j.attempt_count<4 and (j.next_retry_at is null or j.next_retry_at<=now())
    and public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id)
  order by j.created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.formal_report_jobs_v6 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(600,coalesce(p_lease_seconds,420)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),last_error_class=null,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.formal_report_jobs_v6 where id=v_id;
end $$;

create or replace function public.replace_formal_report_writer_v6(p_job_id uuid,p_lease_token uuid,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_claims jsonb)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.formal_report_jobs_v6%rowtype;v_count integer;begin
  select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'report_v6_lease_invalid'; end if;
  if not public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id) then raise exception 'report_v6_upstream_stale'; end if;
  if jsonb_typeof(p_claims)<>'array' or jsonb_array_length(p_claims)<1 or jsonb_array_length(p_claims)>80 then raise exception 'report_v6_claim_array_invalid'; end if;
  delete from public.formal_report_critic_rows_v6 where report_job_id=j.id;
  delete from public.formal_report_claims_v6 where report_job_id=j.id;
  delete from public.formal_report_pass_runs_v6 where report_job_id=j.id;
  insert into public.formal_report_claims_v6(report_job_id,claim_index,claim_type,candidate_ids,claim_text,claim_text_sha256,support_article_ids,counter_article_ids,caveat)
  select j.id,(x->>'claim_index')::integer,x->>'claim_type',
    array(select jsonb_array_elements_text(coalesce(x->'candidate_ids','[]'::jsonb))::uuid),
    x->>'claim_text',repeat('0',64),
    array(select jsonb_array_elements_text(coalesce(x->'support_article_ids','[]'::jsonb))::uuid),
    array(select jsonb_array_elements_text(coalesce(x->'counter_article_ids','[]'::jsonb))::uuid),
    nullif(x->>'caveat','')
  from jsonb_array_elements(p_claims) x;
  get diagnostics v_count=row_count;
  if v_count<>jsonb_array_length(p_claims) or (select count(distinct claim_index) from public.formal_report_claims_v6 where report_job_id=j.id)<>v_count then raise exception 'report_v6_claim_count_or_index_invalid'; end if;
  insert into public.formal_report_pass_runs_v6(report_job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256)
  values(j.id,'writer',left(btrim(p_model),200),btrim(p_provider_response_id),p_prompt_sha256,p_response_sha256);
  return jsonb_build_object('status','writer_stored','claim_count',v_count,'claims',(select jsonb_agg(jsonb_build_object('claim_id',id,'claim_index',claim_index,'claim_text_sha256',claim_text_sha256) order by claim_index) from public.formal_report_claims_v6 where report_job_id=j.id));
end $$;

create or replace function public.replace_formal_report_critic_v6(p_job_id uuid,p_lease_token uuid,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.formal_report_jobs_v6%rowtype;w public.formal_report_pass_runs_v6%rowtype;v_expected integer;v_count integer;begin
  select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'report_v6_lease_invalid'; end if;
  select * into w from public.formal_report_pass_runs_v6 where report_job_id=j.id and pass_kind='writer';
  if w.id is null then raise exception 'report_v6_writer_receipt_required'; end if;
  if w.model=btrim(p_model) or w.provider_response_id=btrim(p_provider_response_id) or w.prompt_sha256=p_prompt_sha256 then raise exception 'report_v6_critic_not_independent'; end if;
  select count(*)::integer into v_expected from public.formal_report_claims_v6 where report_job_id=j.id;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<>v_expected then raise exception 'report_v6_critic_row_count_mismatch'; end if;
  delete from public.formal_report_critic_rows_v6 where report_job_id=j.id;
  delete from public.formal_report_pass_runs_v6 where report_job_id=j.id and pass_kind='critic';
  insert into public.formal_report_critic_rows_v6(report_job_id,claim_id,claim_text_sha256,verdict,evidence_sufficient,numeric_accuracy,causal_strength_ok,scope_ok,counterevidence_handled,notes)
  select j.id,c.id,c.claim_text_sha256,x->>'verdict',(x->>'evidence_sufficient')::boolean,(x->>'numeric_accuracy')::boolean,(x->>'causal_strength_ok')::boolean,(x->>'scope_ok')::boolean,(x->>'counterevidence_handled')::boolean,coalesce(x->>'notes','')
  from jsonb_array_elements(p_rows) x join public.formal_report_claims_v6 c on c.report_job_id=j.id and c.claim_index=(x->>'claim_index')::integer;
  get diagnostics v_count=row_count;
  if v_count<>v_expected then raise exception 'report_v6_critic_insert_count_mismatch'; end if;
  insert into public.formal_report_pass_runs_v6(report_job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256)
  values(j.id,'critic',left(btrim(p_model),200),btrim(p_provider_response_id),p_prompt_sha256,p_response_sha256);
  return jsonb_build_object('status','critic_stored','row_count',v_count);
end $$;

create or replace function public.formal_report_integrity_v6(p_job_id uuid)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
with j as (select * from public.formal_report_jobs_v6 where id=p_job_id),passes as (
 select max(model) filter(where pass_kind='writer') wm,max(model) filter(where pass_kind='critic') cm,max(provider_response_id) filter(where pass_kind='writer') wr,max(provider_response_id) filter(where pass_kind='critic') cr,max(prompt_sha256) filter(where pass_kind='writer') wp,max(prompt_sha256) filter(where pass_kind='critic') cp,count(*) pc from public.formal_report_pass_runs_v6 where report_job_id=p_job_id
),coverage as (
 select count(*)::integer covered from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and s.candidate_id=any(c.candidate_ids) and c.claim_type in ('observed','inferred','implication'))
),counter_cov as (
 select count(*)::integer covered from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and s.counter_count>0 and exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and s.candidate_id=any(c.candidate_ids) and cardinality(c.counter_article_ids)>0)
),counter_need as (select count(*)::integer needed from public.theme_major_selection_v6 s,j where s.analysis_run_id=j.analysis_run_id and s.selected_for_report and s.counter_count>0)
select exists(
 select 1 from j cross join passes p cross join coverage cv cross join counter_cov cc cross join counter_need cn
 where public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id)
   and public.theme_analysis_proof_integrity_v6(j.analysis_run_id)
   and j.candidate_set_fingerprint=(select candidate_set_fingerprint from public.theme_analysis_proof_receipts_v6 where id=j.theme_proof_receipt_id)
   and j.census_identity_fingerprint=public.theme_census_identity_fingerprint_v6(j.analysis_run_id)
   and j.metrics_fingerprint=public.theme_metrics_fingerprint_v6(j.analysis_run_id)
   and j.selection_fingerprint=public.theme_selection_fingerprint_v6(j.analysis_run_id)
   and j.evidence_fingerprint=public.theme_evidence_fingerprint_v6(j.analysis_run_id)
   and j.selected_theme_count=(select count(*) from public.theme_major_selection_v6 s where s.analysis_run_id=j.analysis_run_id and s.selected_for_report)
   and p.pc=2 and p.wm<>p.cm and p.wr<>p.cr and p.wp<>p.cp
   and (select count(*) from public.formal_report_claims_v6 c where c.report_job_id=j.id)>0
   and (select count(*) from public.formal_report_critic_rows_v6 r where r.report_job_id=j.id)=(select count(*) from public.formal_report_claims_v6 c where c.report_job_id=j.id)
   and not exists(select 1 from public.formal_report_critic_rows_v6 r join public.formal_report_claims_v6 c on c.id=r.claim_id where r.report_job_id=j.id and (r.claim_text_sha256<>c.claim_text_sha256 or r.verdict<>'supported' or not r.evidence_sufficient or not r.numeric_accuracy or not r.causal_strength_ok or not r.scope_ok or not r.counterevidence_handled))
   and cv.covered=j.selected_theme_count
   and cc.covered=cn.needed
   and (j.selected_theme_count<2 or exists(select 1 from public.formal_report_claims_v6 c where c.report_job_id=j.id and c.claim_type='cross_theme_narrative' and cardinality(c.candidate_ids)>=2))
);
$$;

create or replace function public.finalize_formal_report_job_v6(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.formal_report_jobs_v6%rowtype;begin
  select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'report_v6_lease_invalid'; end if;
  if not public.formal_report_integrity_v6(j.id) then
    update public.formal_report_jobs_v6 set status='needs_review',last_error_class='report_v6_integrity_failed',error_message='claim graph or critic integrity failed',lease_token=null,lease_expires_at=null,next_retry_at=null,finished_at=now(),updated_at=now() where id=j.id;
    return jsonb_build_object('status','needs_review');
  end if;
  update public.formal_report_jobs_v6 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','claim_count',(select count(*) from public.formal_report_claims_v6 where report_job_id=j.id));
end $$;

revoke execute on function public.create_formal_report_job_v6(uuid,text),public.claim_formal_report_job_v6(integer),public.replace_formal_report_writer_v6(uuid,uuid,text,text,text,text,jsonb),public.replace_formal_report_critic_v6(uuid,uuid,text,text,text,text,jsonb),public.finalize_formal_report_job_v6(uuid,uuid),public.formal_report_integrity_v6(uuid),public.strict_analysis_prerequisites_pass_v7(uuid) from public,anon,authenticated;
grant execute on function public.create_formal_report_job_v6(uuid,text),public.claim_formal_report_job_v6(integer),public.replace_formal_report_writer_v6(uuid,uuid,text,text,text,text,jsonb),public.replace_formal_report_critic_v6(uuid,uuid,text,text,text,text,jsonb),public.finalize_formal_report_job_v6(uuid,uuid),public.formal_report_integrity_v6(uuid),public.strict_analysis_prerequisites_pass_v7(uuid) to service_role;
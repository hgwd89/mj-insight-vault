create table public.theme_candidate_synthesis_jobs_v5 (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references public.theme_analysis_runs_v4(id) on delete cascade,
  scan_run_id uuid not null references public.full_corpus_scan_runs(id),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  seed_count integer not null,
  seed_set_fingerprint text not null check(seed_set_fingerprint ~ '^[0-9a-f]{64}$'),
  synthesis_version text not null default 'theme_candidate_v5_all_seed_synthesis',
  status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed')),
  attempt_count integer not null default 0,
  lease_token uuid,lease_expires_at timestamptz,next_retry_at timestamptz,last_error_class text,error_message text,
  started_at timestamptz,finished_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.theme_candidate_synthesis_pass_runs_v5 (
  job_id uuid not null references public.theme_candidate_synthesis_jobs_v5(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('synthesizer','critic')),
  model text not null,provider_response_id text not null unique,prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,pass_kind)
);
create table public.theme_candidate_proposals_v5 (
  job_id uuid not null references public.theme_candidate_synthesis_jobs_v5(id) on delete cascade,
  proposal_key text not null,
  title text not null,definition text not null,scope_boundary text not null,merge_notes text not null default '',subject text not null,measurement text not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,proposal_key),unique(job_id,title)
);
create table public.theme_candidate_critic_rows_v5 (
  job_id uuid not null,proposal_key text not null,verdict text not null check(verdict in ('approved','rejected','unresolved')),reason text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,proposal_key),foreign key(job_id,proposal_key) references public.theme_candidate_proposals_v5(job_id,proposal_key) on delete cascade
);

create table public.theme_seed_mapping_jobs_v5 (
  id uuid primary key default gen_random_uuid(),analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  batch_index integer not null,seed_ids uuid[] not null,seed_count integer not null,candidate_set_fingerprint text not null check(candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),seed_batch_fingerprint text not null check(seed_batch_fingerprint ~ '^[0-9a-f]{64}$'),
  mapping_version text not null default 'theme_seed_mapping_v5_dual',status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed')),
  attempt_count integer not null default 0,lease_token uuid,lease_expires_at timestamptz,next_retry_at timestamptz,last_error_class text,error_message text,started_at timestamptz,finished_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(analysis_run_id,batch_index,mapping_version),check(seed_count=cardinality(seed_ids))
);
create table public.theme_seed_mapping_pass_runs_v5 (
  job_id uuid not null references public.theme_seed_mapping_jobs_v5(id) on delete cascade,pass_kind text not null check(pass_kind in ('mapper','critic')),model text not null,provider_response_id text not null unique,prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,pass_kind)
);
create table public.theme_seed_mapping_stage_v5 (
  job_id uuid not null references public.theme_seed_mapping_jobs_v5(id) on delete cascade,pass_kind text not null check(pass_kind in ('mapper','critic')),seed_id uuid not null references public.full_corpus_theme_seeds_v4(id) on delete cascade,mapping_status text not null check(mapping_status in ('mapped','rejected')),candidate_id uuid references public.theme_candidates_v4(id),rejection_reason text,reason text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,pass_kind,seed_id),check((mapping_status='mapped' and candidate_id is not null and rejection_reason is null) or (mapping_status='rejected' and candidate_id is null and coalesce(length(btrim(rejection_reason)),0)>=4))
);

create function public.theme_seed_set_proof_v5(p_scan_run_id uuid)
returns table(seed_count integer,seed_set_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with s as (
  select s.id,s.article_id,s.seed_label,s.seed_statement,s.subject,s.measurement,s.source_clean_body_sha256,s.source_region_sha256,s.source_block_index,s.source_block_sha256,s.source_anchor,s.confidence
  from public.full_corpus_theme_seeds_v4 s
  where s.run_id=p_scan_run_id and s.seed_version='theme_seed_v5_source_block'
), c as (
  select count(*)::integer n,coalesce(string_agg(encode(extensions.digest(convert_to(jsonb_build_array(id::text,article_id::text,seed_label,seed_statement,subject,measurement,source_clean_body_sha256,source_region_sha256,source_block_index,source_block_sha256,source_anchor,confidence)::text,'UTF8'),'sha256'),'hex'),'|' order by id::text),'') payload from s
)
select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex') from c;
$$;

create function public.create_theme_analysis_run_v5(p_scan_run_id uuid)
returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_scan public.full_corpus_scan_runs%rowtype;v_id uuid;v_seed record;v_freeze uuid;begin
  select * into v_scan from public.full_corpus_scan_runs where id=p_scan_run_id;
  if not found or not public.full_corpus_run_integrity_v5(p_scan_run_id) then raise exception 'theme_v5_valid_scan_required'; end if;
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';if v_freeze is null then raise exception 'theme_v5_freeze_required'; end if;
  select * into v_seed from public.theme_seed_set_proof_v5(p_scan_run_id);if v_seed.seed_count<=0 then raise exception 'theme_v5_seed_set_empty'; end if;
  insert into public.theme_analysis_runs_v4(scan_run_id,scope_type,scope_query,analysis_version,synthesis_version,census_version,prompt_version,status,source_truth_fingerprint,source_grounded_fingerprint,expected_article_count,expected_seed_count)
  values(p_scan_run_id,'all',null,'theme_analysis_v5_all_seed_dual_mapping','theme_candidate_v5_all_seed_synthesis','theme_census_v5_dual_source_block','theme_analysis_v5_all_seed_dual_mapping','discovering',v_scan.source_truth_fingerprint,v_scan.source_grounded_fingerprint,v_scan.active_article_count,v_seed.seed_count) returning id into v_id;
  insert into public.theme_candidate_synthesis_jobs_v5(analysis_run_id,scan_run_id,freeze_receipt_id,seed_count,seed_set_fingerprint) values(v_id,p_scan_run_id,v_freeze,v_seed.seed_count,v_seed.seed_set_fingerprint);
  return v_id;
end $$;

create function public.claim_theme_candidate_synthesis_job_v5(p_lease_seconds integer default 600)
returns setof public.theme_candidate_synthesis_jobs_v5 language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();begin
  if (select freeze_gate_v2 from public.formal_corpus_freeze_gate_v2)<>'passed' then raise exception 'theme_synthesis_v5_freeze_stale'; end if;
  select id into v_id from public.theme_candidate_synthesis_jobs_v5 where (status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at<now()))) and attempt_count<4 and (next_retry_at is null or next_retry_at<=now()) order by created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.theme_candidate_synthesis_jobs_v5 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(300,least(900,coalesce(p_lease_seconds,600)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null where id=v_id;
  return query select * from public.theme_candidate_synthesis_jobs_v5 where id=v_id;
end $$;

create function public.get_theme_candidate_synthesis_input_v5(p_job_id uuid,p_lease_token uuid,p_pass_kind text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.theme_candidate_synthesis_jobs_v5%rowtype;sp record;v_seeds jsonb;v_props jsonb;begin
  select * into j from public.theme_candidate_synthesis_jobs_v5 where id=p_job_id;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'theme_synthesis_v5_lease_invalid'; end if;
  if p_pass_kind not in ('synthesizer','critic') then raise exception 'theme_synthesis_v5_pass_invalid'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'theme_synthesis_v5_freeze_stale'; end if;
  select * into sp from public.theme_seed_set_proof_v5(j.scan_run_id);if sp.seed_count<>j.seed_count or sp.seed_set_fingerprint<>j.seed_set_fingerprint then raise exception 'theme_synthesis_v5_seed_set_stale'; end if;
  select jsonb_agg(jsonb_build_object('seed_id',s.id,'article_id',s.article_id,'seed_label',s.seed_label,'seed_statement',s.seed_statement,'subject',s.subject,'measurement',s.measurement,'confidence',s.confidence,'source_anchor',s.source_anchor) order by s.id) into v_seeds from public.full_corpus_theme_seeds_v4 s where s.run_id=j.scan_run_id and s.seed_version='theme_seed_v5_source_block';
  if p_pass_kind='critic' then select jsonb_agg(jsonb_build_object('proposal_key',p.proposal_key,'title',p.title,'definition',p.definition,'scope_boundary',p.scope_boundary,'merge_notes',p.merge_notes,'subject',p.subject,'measurement',p.measurement) order by p.proposal_key) into v_props from public.theme_candidate_proposals_v5 p where p.job_id=j.id; if coalesce(jsonb_array_length(v_props),0)=0 then raise exception 'theme_synthesis_v5_critic_requires_proposals'; end if; end if;
  return jsonb_build_object('job_id',j.id,'analysis_run_id',j.analysis_run_id,'seed_count',j.seed_count,'seed_set_fingerprint',j.seed_set_fingerprint,'pass_kind',p_pass_kind,'seeds',v_seeds,'proposals',case when p_pass_kind='critic' then v_props else null end);
end $$;

create function public.store_theme_candidate_synthesis_pass_v5(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.theme_candidate_synthesis_jobs_v5%rowtype;v_other public.theme_candidate_synthesis_pass_runs_v5%rowtype;v_n integer;begin
  select * into j from public.theme_candidate_synthesis_jobs_v5 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'theme_synthesis_v5_lease_invalid'; end if;
  if p_pass_kind not in ('synthesizer','critic') or coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_rows)<>'array' then raise exception 'theme_synthesis_v5_pass_invalid'; end if;
  select * into v_other from public.theme_candidate_synthesis_pass_runs_v5 where job_id=j.id and pass_kind<>p_pass_kind;if found and (v_other.model=p_model or v_other.provider_response_id=p_provider_response_id or v_other.prompt_sha256=p_prompt_sha256) then raise exception 'theme_synthesis_v5_passes_not_independent'; end if;
  if p_pass_kind='synthesizer' then
    select count(*)::integer into v_n from jsonb_to_recordset(p_rows) x(proposal_key text,title text,definition text,scope_boundary text,merge_notes text,subject text,measurement text);
    if v_n<1 then raise exception 'theme_synthesis_v5_no_candidates'; end if;
    if exists(select 1 from jsonb_to_recordset(p_rows) x(proposal_key text,title text,definition text,scope_boundary text,merge_notes text,subject text,measurement text) where char_length(btrim(coalesce(x.proposal_key,'')))<1 or char_length(btrim(coalesce(x.title,'')))<2 or char_length(btrim(coalesce(x.definition,'')))<20 or char_length(btrim(coalesce(x.scope_boundary,'')))<12 or x.subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear') or x.measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')) then raise exception 'theme_synthesis_v5_candidate_invalid'; end if;
    if (select count(distinct proposal_key) from jsonb_to_recordset(p_rows) x(proposal_key text,title text,definition text,scope_boundary text,merge_notes text,subject text,measurement text))<>v_n or (select count(distinct title) from jsonb_to_recordset(p_rows) x(proposal_key text,title text,definition text,scope_boundary text,merge_notes text,subject text,measurement text))<>v_n then raise exception 'theme_synthesis_v5_candidate_keys_or_titles_duplicate'; end if;
    delete from public.theme_candidate_critic_rows_v5 where job_id=j.id;delete from public.theme_candidate_synthesis_pass_runs_v5 where job_id=j.id and pass_kind='critic';delete from public.theme_candidate_proposals_v5 where job_id=j.id;
    insert into public.theme_candidate_proposals_v5(job_id,proposal_key,title,definition,scope_boundary,merge_notes,subject,measurement,updated_at)
    select j.id,x.proposal_key,x.title,x.definition,x.scope_boundary,coalesce(x.merge_notes,''),x.subject,x.measurement,now() from jsonb_to_recordset(p_rows) x(proposal_key text,title text,definition text,scope_boundary text,merge_notes text,subject text,measurement text);
  else
    if (select count(*) from public.theme_candidate_proposals_v5 where job_id=j.id)=0 then raise exception 'theme_synthesis_v5_critic_requires_proposals'; end if;
    select count(*)::integer into v_n from jsonb_to_recordset(p_rows) x(proposal_key text,verdict text,reason text);
    if v_n<>(select count(*) from public.theme_candidate_proposals_v5 where job_id=j.id) or (select count(distinct proposal_key) from jsonb_to_recordset(p_rows) x(proposal_key text,verdict text,reason text))<>v_n then raise exception 'theme_synthesis_v5_critic_count_mismatch'; end if;
    if exists(with expected as (select proposal_key from public.theme_candidate_proposals_v5 where job_id=j.id),supplied as (select proposal_key from jsonb_to_recordset(p_rows) x(proposal_key text,verdict text,reason text)) select 1 from ((select * from expected except select * from supplied) union all (select * from supplied except select * from expected)) d limit 1) then raise exception 'theme_synthesis_v5_critic_set_mismatch'; end if;
    if exists(select 1 from jsonb_to_recordset(p_rows) x(proposal_key text,verdict text,reason text) where x.verdict not in ('approved','rejected','unresolved') or char_length(btrim(coalesce(x.reason,'')))<4) then raise exception 'theme_synthesis_v5_critic_invalid'; end if;
    delete from public.theme_candidate_critic_rows_v5 where job_id=j.id;insert into public.theme_candidate_critic_rows_v5(job_id,proposal_key,verdict,reason,updated_at) select j.id,x.proposal_key,x.verdict,left(x.reason,1500),now() from jsonb_to_recordset(p_rows) x(proposal_key text,verdict text,reason text);
  end if;
  insert into public.theme_candidate_synthesis_pass_runs_v5(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,updated_at) values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now()) on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();
  return jsonb_build_object('status','stored','pass_kind',p_pass_kind,'row_count',v_n);
end $$;

create function public.finalize_theme_candidate_synthesis_v5(p_job_id uuid,p_lease_token uuid,p_seed_batch_size integer default 64)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare j public.theme_candidate_synthesis_jobs_v5%rowtype;sy public.theme_candidate_synthesis_pass_runs_v5%rowtype;cr public.theme_candidate_synthesis_pass_runs_v5%rowtype;v_n integer;v_fp text;v_batch integer:=greatest(32,least(128,coalesce(p_seed_batch_size,64)));begin
  select * into j from public.theme_candidate_synthesis_jobs_v5 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'theme_synthesis_v5_lease_invalid'; end if;
  select * into sy from public.theme_candidate_synthesis_pass_runs_v5 where job_id=j.id and pass_kind='synthesizer';select * into cr from public.theme_candidate_synthesis_pass_runs_v5 where job_id=j.id and pass_kind='critic';if sy.job_id is null or cr.job_id is null or sy.model=cr.model or sy.provider_response_id=cr.provider_response_id or sy.prompt_sha256=cr.prompt_sha256 then raise exception 'theme_synthesis_v5_independent_passes_required'; end if;
  select count(*)::integer into v_n from public.theme_candidate_proposals_v5 p join public.theme_candidate_critic_rows_v5 c using(job_id,proposal_key) where p.job_id=j.id and c.verdict='approved';
  if v_n<>(select count(*) from public.theme_candidate_proposals_v5 where job_id=j.id) then update public.theme_candidate_synthesis_jobs_v5 set status='needs_review',last_error_class='candidate_critic_not_all_approved',error_message='candidate critic did not approve every proposal',lease_token=null,lease_expires_at=null,next_retry_at=null,updated_at=now() where id=j.id;return jsonb_build_object('status','needs_review');end if;
  if exists(select 1 from public.theme_candidates_v4 where analysis_run_id=j.analysis_run_id) then raise exception 'theme_synthesis_v5_final_candidates_already_exist'; end if;
  insert into public.theme_candidates_v4(analysis_run_id,candidate_version,title,definition,scope_boundary,merge_notes,subject,measurement,evidence_article_ids,supporting_batch_indices)
  select j.analysis_run_id,'theme_candidate_v5_all_seed_synthesis',p.title,p.definition,p.scope_boundary,p.merge_notes,p.subject,p.measurement,'{}'::uuid[],'{}'::integer[] from public.theme_candidate_proposals_v5 p where p.job_id=j.id order by p.proposal_key;
  v_fp:=public.theme_candidate_set_fingerprint_v4(j.analysis_run_id);
  with ordered as (select s.id,row_number() over(order by s.id) rn from public.full_corpus_theme_seeds_v4 s where s.run_id=j.scan_run_id and s.seed_version='theme_seed_v5_source_block'),grp as (select ((rn-1)/v_batch+1)::integer batch_index,array_agg(id order by rn) seed_ids from ordered group by ((rn-1)/v_batch+1)::integer)
  insert into public.theme_seed_mapping_jobs_v5(analysis_run_id,batch_index,seed_ids,seed_count,candidate_set_fingerprint,seed_batch_fingerprint)
  select j.analysis_run_id,g.batch_index,g.seed_ids,cardinality(g.seed_ids),v_fp,encode(extensions.digest(convert_to(array_to_string(g.seed_ids,'|'),'UTF8'),'sha256'),'hex') from grp g order by g.batch_index;
  update public.theme_candidate_synthesis_jobs_v5 set status='completed',finished_at=now(),lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','candidate_count',v_n,'candidate_set_fingerprint',v_fp,'mapping_jobs',(select count(*) from public.theme_seed_mapping_jobs_v5 where analysis_run_id=j.analysis_run_id));
end $$;

create function public.claim_theme_seed_mapping_job_v5(p_lease_seconds integer default 420)
returns setof public.theme_seed_mapping_jobs_v5 language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();begin
  select id into v_id from public.theme_seed_mapping_jobs_v5 where (status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at<now()))) and attempt_count<4 and (next_retry_at is null or next_retry_at<=now()) order by created_at for update skip locked limit 1;if v_id is null then return;end if;
  update public.theme_seed_mapping_jobs_v5 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(240,least(600,coalesce(p_lease_seconds,420)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null where id=v_id;return query select * from public.theme_seed_mapping_jobs_v5 where id=v_id;
end $$;

create function public.get_theme_seed_mapping_job_input_v5(p_job_id uuid,p_lease_token uuid,p_pass_kind text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.theme_seed_mapping_jobs_v5%rowtype;v_fp text;v_seeds jsonb;v_candidates jsonb;begin
  select * into j from public.theme_seed_mapping_jobs_v5 where id=p_job_id;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'seed_mapping_v5_lease_invalid';end if;if p_pass_kind not in ('mapper','critic') then raise exception 'seed_mapping_v5_pass_invalid';end if;
  v_fp:=public.theme_candidate_set_fingerprint_v4(j.analysis_run_id);if v_fp<>j.candidate_set_fingerprint then raise exception 'seed_mapping_v5_candidate_set_stale';end if;
  select jsonb_agg(jsonb_build_object('seed_id',s.id,'article_id',s.article_id,'seed_label',s.seed_label,'seed_statement',s.seed_statement,'subject',s.subject,'measurement',s.measurement,'confidence',s.confidence,'source_anchor',s.source_anchor) order by s.id) into v_seeds from public.full_corpus_theme_seeds_v4 s where s.id=any(j.seed_ids);
  select jsonb_agg(jsonb_build_object('candidate_id',c.id,'title',c.title,'definition',c.definition,'scope_boundary',c.scope_boundary,'subject',c.subject,'measurement',c.measurement) order by c.title,c.id) into v_candidates from public.theme_candidates_v4 c where c.analysis_run_id=j.analysis_run_id;
  return jsonb_build_object('job_id',j.id,'analysis_run_id',j.analysis_run_id,'pass_kind',p_pass_kind,'candidate_set_fingerprint',j.candidate_set_fingerprint,'seeds',v_seeds,'candidates',v_candidates);
end $$;

create function public.store_theme_seed_mapping_pass_v5(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.theme_seed_mapping_jobs_v5%rowtype;v_other public.theme_seed_mapping_pass_runs_v5%rowtype;v_n integer;begin
  select * into j from public.theme_seed_mapping_jobs_v5 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'seed_mapping_v5_lease_invalid';end if;
  if p_pass_kind not in ('mapper','critic') or coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_rows)<>'array' then raise exception 'seed_mapping_v5_pass_invalid';end if;
  select * into v_other from public.theme_seed_mapping_pass_runs_v5 where job_id=j.id and pass_kind<>p_pass_kind;if found and (v_other.model=p_model or v_other.provider_response_id=p_provider_response_id or v_other.prompt_sha256=p_prompt_sha256) then raise exception 'seed_mapping_v5_passes_not_independent';end if;
  select count(*)::integer into v_n from jsonb_to_recordset(p_rows) x(seed_id uuid,mapping_status text,candidate_id uuid,rejection_reason text,reason text);if v_n<>j.seed_count or (select count(distinct seed_id) from jsonb_to_recordset(p_rows) x(seed_id uuid,mapping_status text,candidate_id uuid,rejection_reason text,reason text))<>v_n then raise exception 'seed_mapping_v5_count_mismatch';end if;
  if exists(with expected as (select unnest(j.seed_ids) seed_id),supplied as (select seed_id from jsonb_to_recordset(p_rows) x(seed_id uuid,mapping_status text,candidate_id uuid,rejection_reason text,reason text)) select 1 from ((select * from expected except select * from supplied) union all (select * from supplied except select * from expected)) d limit 1) then raise exception 'seed_mapping_v5_seed_set_mismatch';end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(seed_id uuid,mapping_status text,candidate_id uuid,rejection_reason text,reason text) where x.mapping_status not in ('mapped','rejected') or char_length(btrim(coalesce(x.reason,'')))<4 or (x.mapping_status='mapped' and (x.candidate_id is null or not exists(select 1 from public.theme_candidates_v4 c where c.id=x.candidate_id and c.analysis_run_id=j.analysis_run_id))) or (x.mapping_status='rejected' and (x.candidate_id is not null or char_length(btrim(coalesce(x.rejection_reason,'')))<4))) then raise exception 'seed_mapping_v5_row_invalid';end if;
  delete from public.theme_seed_mapping_stage_v5 where job_id=j.id and pass_kind=p_pass_kind;
  insert into public.theme_seed_mapping_stage_v5(job_id,pass_kind,seed_id,mapping_status,candidate_id,rejection_reason,reason,updated_at) select j.id,p_pass_kind,x.seed_id,x.mapping_status,x.candidate_id,case when x.mapping_status='rejected' then x.rejection_reason else null end,left(x.reason,1000),now() from jsonb_to_recordset(p_rows) x(seed_id uuid,mapping_status text,candidate_id uuid,rejection_reason text,reason text);
  insert into public.theme_seed_mapping_pass_runs_v5(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,updated_at) values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now()) on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();
  return jsonb_build_object('status','stored','pass_kind',p_pass_kind,'row_count',v_n);
end $$;

create function public.finalize_theme_seed_mapping_job_v5(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.theme_seed_mapping_jobs_v5%rowtype;mp public.theme_seed_mapping_pass_runs_v5%rowtype;cr public.theme_seed_mapping_pass_runs_v5%rowtype;v_disagree integer;begin
  select * into j from public.theme_seed_mapping_jobs_v5 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'seed_mapping_v5_lease_invalid';end if;
  if public.theme_candidate_set_fingerprint_v4(j.analysis_run_id)<>j.candidate_set_fingerprint then raise exception 'seed_mapping_v5_candidate_set_stale';end if;
  select * into mp from public.theme_seed_mapping_pass_runs_v5 where job_id=j.id and pass_kind='mapper';select * into cr from public.theme_seed_mapping_pass_runs_v5 where job_id=j.id and pass_kind='critic';if mp.job_id is null or cr.job_id is null or mp.model=cr.model or mp.provider_response_id=cr.provider_response_id or mp.prompt_sha256=cr.prompt_sha256 then raise exception 'seed_mapping_v5_independent_passes_required';end if;
  if (select count(*) from public.theme_seed_mapping_stage_v5 where job_id=j.id and pass_kind='mapper')<>j.seed_count or (select count(*) from public.theme_seed_mapping_stage_v5 where job_id=j.id and pass_kind='critic')<>j.seed_count then raise exception 'seed_mapping_v5_stage_incomplete';end if;
  select count(*)::integer into v_disagree from public.theme_seed_mapping_stage_v5 m join public.theme_seed_mapping_stage_v5 c on c.job_id=m.job_id and c.seed_id=m.seed_id and c.pass_kind='critic' where m.job_id=j.id and m.pass_kind='mapper' and (m.mapping_status<>c.mapping_status or m.candidate_id is distinct from c.candidate_id);
  if v_disagree>0 then update public.theme_seed_mapping_jobs_v5 set status='needs_review',last_error_class='mapping_disagreement',error_message=format('dual mapping disagreements=%s',v_disagree),lease_token=null,lease_expires_at=null,next_retry_at=null,updated_at=now() where id=j.id;return jsonb_build_object('status','needs_review','disagreements',v_disagree);end if;
  insert into public.theme_seed_mappings_v4(analysis_run_id,seed_id,mapping_version,mapping_status,candidate_id,rejection_reason)
  select j.analysis_run_id,m.seed_id,'theme_seed_mapping_v5_dual',m.mapping_status,m.candidate_id,case when m.mapping_status='rejected' then m.rejection_reason else null end from public.theme_seed_mapping_stage_v5 m where m.job_id=j.id and m.pass_kind='mapper';
  update public.theme_seed_mapping_jobs_v5 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;return jsonb_build_object('status','completed','seed_count',j.seed_count);
end $$;

create function public.lock_theme_candidate_set_v5(p_analysis_run_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.theme_analysis_runs_v4%rowtype;v_seed record;v_jobs integer;v_completed integer;v_fp text;begin
  select * into a from public.theme_analysis_runs_v4 where id=p_analysis_run_id for update;if not found or a.status<>'discovering' then raise exception 'theme_lock_v5_run_not_discovering';end if;
  select * into v_seed from public.theme_seed_set_proof_v5(a.scan_run_id);if v_seed.seed_count<>a.expected_seed_count then raise exception 'theme_lock_v5_seed_set_stale';end if;
  select count(*)::integer,count(*) filter(where status='completed')::integer into v_jobs,v_completed from public.theme_seed_mapping_jobs_v5 where analysis_run_id=a.id;if v_jobs=0 or v_completed<>v_jobs then raise exception 'theme_lock_v5_mapping_jobs_incomplete';end if;
  if (select count(*) from public.theme_seed_mappings_v4 where analysis_run_id=a.id and mapping_version='theme_seed_mapping_v5_dual')<>a.expected_seed_count then raise exception 'theme_lock_v5_mapping_count_mismatch';end if;
  if exists(select 1 from public.theme_candidates_v4 c where c.analysis_run_id=a.id and not exists(select 1 from public.theme_seed_mappings_v4 m where m.analysis_run_id=a.id and m.candidate_id=c.id and m.mapping_status='mapped' and m.mapping_version='theme_seed_mapping_v5_dual')) then raise exception 'theme_lock_v5_candidate_without_mapped_seed';end if;
  v_fp:=public.lock_theme_candidate_set_v4(a.id);
  return jsonb_build_object('status','candidate_locked','candidate_set_fingerprint',v_fp,'seed_count',a.expected_seed_count,'candidate_count',(select count(*) from public.theme_candidates_v4 where analysis_run_id=a.id));
end $$;

alter table public.theme_candidate_synthesis_jobs_v5 enable row level security;alter table public.theme_candidate_synthesis_pass_runs_v5 enable row level security;alter table public.theme_candidate_proposals_v5 enable row level security;alter table public.theme_candidate_critic_rows_v5 enable row level security;alter table public.theme_seed_mapping_jobs_v5 enable row level security;alter table public.theme_seed_mapping_pass_runs_v5 enable row level security;alter table public.theme_seed_mapping_stage_v5 enable row level security;
revoke all on table public.theme_candidate_synthesis_jobs_v5,public.theme_candidate_synthesis_pass_runs_v5,public.theme_candidate_proposals_v5,public.theme_candidate_critic_rows_v5,public.theme_seed_mapping_jobs_v5,public.theme_seed_mapping_pass_runs_v5,public.theme_seed_mapping_stage_v5 from anon,authenticated,service_role;grant select on table public.theme_candidate_synthesis_jobs_v5,public.theme_candidate_synthesis_pass_runs_v5,public.theme_candidate_proposals_v5,public.theme_candidate_critic_rows_v5,public.theme_seed_mapping_jobs_v5,public.theme_seed_mapping_pass_runs_v5,public.theme_seed_mapping_stage_v5 to service_role;
revoke insert,update,delete,truncate,references,trigger on table public.theme_candidates_v4,public.theme_seed_mappings_v4 from service_role;grant select on table public.theme_candidates_v4,public.theme_seed_mappings_v4 to service_role;
revoke execute on function public.theme_seed_set_proof_v5(uuid) from public,anon,authenticated;revoke execute on function public.create_theme_analysis_run_v5(uuid) from public,anon,authenticated;revoke execute on function public.claim_theme_candidate_synthesis_job_v5(integer) from public,anon,authenticated;revoke execute on function public.get_theme_candidate_synthesis_input_v5(uuid,uuid,text) from public,anon,authenticated;revoke execute on function public.store_theme_candidate_synthesis_pass_v5(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;revoke execute on function public.finalize_theme_candidate_synthesis_v5(uuid,uuid,integer) from public,anon,authenticated;revoke execute on function public.claim_theme_seed_mapping_job_v5(integer) from public,anon,authenticated;revoke execute on function public.get_theme_seed_mapping_job_input_v5(uuid,uuid,text) from public,anon,authenticated;revoke execute on function public.store_theme_seed_mapping_pass_v5(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;revoke execute on function public.finalize_theme_seed_mapping_job_v5(uuid,uuid) from public,anon,authenticated;revoke execute on function public.lock_theme_candidate_set_v5(uuid) from public,anon,authenticated;
grant execute on function public.theme_seed_set_proof_v5(uuid) to service_role;grant execute on function public.create_theme_analysis_run_v5(uuid) to service_role;grant execute on function public.claim_theme_candidate_synthesis_job_v5(integer) to service_role;grant execute on function public.get_theme_candidate_synthesis_input_v5(uuid,uuid,text) to service_role;grant execute on function public.store_theme_candidate_synthesis_pass_v5(uuid,uuid,text,text,text,text,text,jsonb) to service_role;grant execute on function public.finalize_theme_candidate_synthesis_v5(uuid,uuid,integer) to service_role;grant execute on function public.claim_theme_seed_mapping_job_v5(integer) to service_role;grant execute on function public.get_theme_seed_mapping_job_input_v5(uuid,uuid,text) to service_role;grant execute on function public.store_theme_seed_mapping_pass_v5(uuid,uuid,text,text,text,text,text,jsonb) to service_role;grant execute on function public.finalize_theme_seed_mapping_job_v5(uuid,uuid) to service_role;grant execute on function public.lock_theme_candidate_set_v5(uuid) to service_role;
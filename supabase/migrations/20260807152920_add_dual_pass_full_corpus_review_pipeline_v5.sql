alter table public.full_corpus_article_reviews_v4
  alter column observed_fact_anchor set not null,
  alter column observed_fact_block_index set not null,
  alter column observed_fact_block_sha256 set not null;

alter table public.full_corpus_theme_seeds_v4
  alter column source_block_index set not null,
  alter column source_block_sha256 set not null;

create table public.full_corpus_review_jobs_v5 (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.full_corpus_scan_runs(id) on delete cascade,
  batch_id uuid not null references public.full_corpus_scan_batches(id) on delete cascade,
  batch_index integer not null,
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  source_grounded_fingerprint text not null check(source_grounded_fingerprint ~ '^[0-9a-f]{64}$'),
  batch_article_set_fingerprint text not null check(batch_article_set_fingerprint ~ '^[0-9a-f]{64}$'),
  batch_input_fingerprint text not null check(batch_input_fingerprint ~ '^[0-9a-f]{64}$'),
  article_count integer not null check(article_count>0),
  review_version text not null default 'article_review_v5_dual_source_block',
  status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed')),
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_class text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,batch_id,review_version)
);
create index full_corpus_review_jobs_v5_status_idx on public.full_corpus_review_jobs_v5(status,next_retry_at,created_at);

create table public.full_corpus_review_pass_runs_v5 (
  job_id uuid not null references public.full_corpus_review_jobs_v5(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('reviewer','critic')),
  model text not null,
  provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(job_id,pass_kind)
);

create table public.full_corpus_reviewer_rows_v5 (
  job_id uuid not null references public.full_corpus_review_jobs_v5(id) on delete cascade,
  article_id uuid not null references public.articles(id),
  reviewer_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(job_id,article_id)
);

create table public.full_corpus_review_critic_rows_v5 (
  job_id uuid not null references public.full_corpus_review_jobs_v5(id) on delete cascade,
  article_id uuid not null references public.articles(id),
  verdict text not null check(verdict in ('approved','rejected','unresolved')),
  fact_supported boolean not null,
  coverage_complete boolean not null,
  no_theme_signal_valid boolean not null,
  seeds_grounded boolean not null,
  overclaim_risk boolean not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(job_id,article_id),
  check(verdict<>'approved' or (fact_supported and coverage_complete and no_theme_signal_valid and seeds_grounded and not overclaim_risk))
);

create function public.review_batch_article_set_proof_v5(p_batch_id uuid)
returns table(article_count integer,article_set_fingerprint text,batch_input_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with b as (
  select * from public.full_corpus_scan_batches where id=p_batch_id
), x as (
  select g.article_id,g.source_region_id,g.partition_job_id,g.source_region_sha256,g.current_source_raw_ocr_sha256,
         coalesce((select string_agg(t.anchor_slot||':'||t.block_index::text||':'||t.source_block_sha256,'|' order by t.anchor_slot) from public.source_region_coverage_targets_v4 t where t.article_id=g.article_id and t.source_region_id=g.source_region_id),'') coverage_targets
  from b cross join lateral unnest(b.article_ids) u(article_id)
  join public.formal_source_grounded_articles_v4 g on g.article_id=u.article_id
), c as (
  select count(*)::integer n,
         coalesce(string_agg(article_id::text,'|' order by article_id::text),'') article_payload,
         coalesce(string_agg(encode(extensions.digest(convert_to(jsonb_build_array(article_id::text,source_region_id::text,partition_job_id::text,source_region_sha256,current_source_raw_ocr_sha256,coverage_targets)::text,'UTF8'),'sha256'),'hex'),'|' order by article_id::text),'') input_payload
  from x
)
select n,
       encode(extensions.digest(convert_to(article_payload,'UTF8'),'sha256'),'hex'),
       encode(extensions.digest(convert_to(input_payload,'UTF8'),'sha256'),'hex')
from c;
$$;

create function public.validate_reviewer_json_v5(p_article_id uuid,p_reviewer_json jsonb)
returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  g public.formal_source_grounded_articles_v4%rowtype;
  v_subject text;v_measurement text;v_fact text;v_fact_anchor text;v_no_theme boolean;v_no_reason text;
  v_expected_count integer;v_anchor_count integer;v_seed_count integer;
begin
  if jsonb_typeof(p_reviewer_json)<>'object' then raise exception 'review_v5_row_must_be_object'; end if;
  select * into g from public.formal_source_grounded_articles_v4 where article_id=p_article_id;
  if not found then raise exception 'review_v5_article_not_source_grounded'; end if;
  v_subject:=p_reviewer_json->>'subject';v_measurement:=p_reviewer_json->>'measurement';v_fact:=btrim(coalesce(p_reviewer_json->>'observed_fact',''));v_fact_anchor:=btrim(coalesce(p_reviewer_json->>'observed_fact_anchor',''));v_no_theme:=coalesce((p_reviewer_json->>'no_theme_signal')::boolean,false);v_no_reason:=btrim(coalesce(p_reviewer_json->>'no_theme_signal_reason',''));
  if v_subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear') then raise exception 'review_v5_subject_invalid'; end if;
  if v_measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other') then raise exception 'review_v5_measurement_invalid'; end if;
  if char_length(v_fact)<8 or char_length(v_fact_anchor)<6 or not public.source_region_anchor_unique_block_v4(p_article_id,g.source_region_id,v_fact_anchor) then raise exception 'review_v5_observed_fact_not_grounded'; end if;
  if coalesce(btrim(p_reviewer_json->>'limitation'),'')='' then raise exception 'review_v5_limitation_required'; end if;
  if v_no_theme and char_length(v_no_reason)<8 then raise exception 'review_v5_no_theme_reason_required'; end if;

  select count(*)::integer into v_expected_count from public.source_region_coverage_targets_v4 where article_id=p_article_id and source_region_id=g.source_region_id;
  select count(*)::integer into v_anchor_count from jsonb_array_elements(coalesce(p_reviewer_json->'coverage_anchors','[]'::jsonb));
  if v_anchor_count<>v_expected_count then raise exception 'review_v5_coverage_anchor_count_mismatch'; end if;
  if exists(
    select 1 from public.source_region_coverage_targets_v4 t
    where t.article_id=p_article_id and t.source_region_id=g.source_region_id
      and not exists(
        select 1 from jsonb_to_recordset(coalesce(p_reviewer_json->'coverage_anchors','[]'::jsonb)) a(anchor_slot text,block_index integer,anchor_text text)
        where a.anchor_slot=t.anchor_slot and a.block_index=t.block_index and public.normalized_occurrence_count_v4(t.block_text,a.anchor_text)=1
      )
  ) then raise exception 'review_v5_coverage_target_missing_or_invalid'; end if;
  if exists(
    select 1 from jsonb_to_recordset(coalesce(p_reviewer_json->'coverage_anchors','[]'::jsonb)) a(anchor_slot text,block_index integer,anchor_text text)
    left join public.source_region_coverage_targets_v4 t on t.article_id=p_article_id and t.source_region_id=g.source_region_id and t.anchor_slot=a.anchor_slot and t.block_index=a.block_index
    where t.article_id is null or public.normalized_occurrence_count_v4(t.block_text,a.anchor_text)<>1
  ) then raise exception 'review_v5_extra_or_invalid_coverage_anchor'; end if;

  select count(*)::integer into v_seed_count from jsonb_array_elements(coalesce(p_reviewer_json->'theme_seeds','[]'::jsonb));
  if v_no_theme and v_seed_count<>0 then raise exception 'review_v5_no_theme_must_have_zero_seeds'; end if;
  if not v_no_theme and v_seed_count<1 then raise exception 'review_v5_theme_signal_requires_seed'; end if;
  if exists(
    select 1 from jsonb_to_recordset(coalesce(p_reviewer_json->'theme_seeds','[]'::jsonb)) s(seed_label text,seed_statement text,subject text,measurement text,confidence numeric,source_anchor text)
    where char_length(btrim(coalesce(s.seed_label,'')))<2
       or char_length(btrim(coalesce(s.seed_statement,'')))<8
       or s.subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear')
       or s.measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')
       or coalesce(s.confidence,-1)<0 or coalesce(s.confidence,-1)>1
       or char_length(btrim(coalesce(s.source_anchor,'')))<6
       or not public.source_region_anchor_unique_block_v4(p_article_id,g.source_region_id,s.source_anchor)
  ) then raise exception 'review_v5_theme_seed_invalid_or_ungrounded'; end if;
  return true;
end $$;

create function public.create_full_corpus_scan_run_v5(p_batch_size integer default 16)
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare
  v_freeze uuid;v_truth record;v_ground record;v_run uuid;v_batch_size integer:=greatest(8,least(24,coalesce(p_batch_size,16)));v_total integer;
begin
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'scan_v5_freeze_v2_required'; end if;
  if (select source_region_gate from public.article_source_region_gate_v4)<>'passed' then raise exception 'scan_v5_source_region_required'; end if;
  if (select embedding_gate from public.article_embedding_quality_gate_v4)<>'passed' then raise exception 'scan_v5_embedding_required'; end if;
  if (select duplicate_gate from public.formal_corpus_duplicate_gate_v5)<>'passed' then raise exception 'scan_v5_duplicate_audit_required'; end if;
  if (select category_classification_gate from public.category_classification_gate_v4)<>'passed' then raise exception 'scan_v5_classification_required'; end if;
  select * into v_truth from public.formal_corpus_scope_proof_v4('all','');select * into v_ground from public.formal_source_grounded_scope_proof_v4('all','');
  if v_truth.article_count<=0 or v_truth.article_count<>v_ground.article_count then raise exception 'scan_v5_truth_grounding_count_mismatch'; end if;
  v_total:=ceil(v_ground.article_count::numeric/v_batch_size)::integer;
  insert into public.full_corpus_scan_runs(scope_type,scope_query,status,model,batch_size,active_article_count,ocr_ready_article_count,total_batches,completed_batches,failed_batches,analyzed_article_count,coverage_json,needs_review_batches,corpus_fingerprint,source_truth_fingerprint,source_grounded_fingerprint,analysis_contract_version,started_at)
  values('all',null,'running','dual-review-v5',v_batch_size,v_ground.article_count,v_ground.article_count,v_total,0,0,0,jsonb_build_object('prompt_version','full_corpus_batch_v5_dual_source_block_review','proof_mode','one_article_one_review_no_server_normalization','freeze_receipt_id',v_freeze),0,v_truth.source_truth_fingerprint,v_truth.source_truth_fingerprint,v_ground.source_grounded_fingerprint,'strict_report_v5_dual_source_review_census',now()) returning id into v_run;

  with ordered as (
    select g.article_id,row_number() over(order by g.article_date nulls last,g.article_id) rn
    from public.formal_source_grounded_articles_v4 g
  ), grouped as (
    select ((rn-1)/v_batch_size+1)::integer batch_index,array_agg(article_id order by rn) article_ids
    from ordered group by ((rn-1)/v_batch_size+1)::integer
  )
  insert into public.full_corpus_scan_batches(run_id,batch_index,article_ids,article_count,status,model,prompt_version,evidence_article_ids)
  select v_run,batch_index,article_ids,cardinality(article_ids),'queued','dual-review-v5','full_corpus_batch_v5_dual_source_block_review','{}'::text[] from grouped order by batch_index;

  insert into public.full_corpus_review_jobs_v5(run_id,batch_id,batch_index,freeze_receipt_id,source_grounded_fingerprint,batch_article_set_fingerprint,batch_input_fingerprint,article_count)
  select v_run,b.id,b.batch_index,v_freeze,v_ground.source_grounded_fingerprint,p.article_set_fingerprint,p.batch_input_fingerprint,p.article_count
  from public.full_corpus_scan_batches b cross join lateral public.review_batch_article_set_proof_v5(b.id) p where b.run_id=v_run;
  return v_run;
end $$;

create function public.claim_full_corpus_review_job_v5(p_lease_seconds integer default 420)
returns setof public.full_corpus_review_jobs_v5
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();begin
  if (select freeze_gate_v2 from public.formal_corpus_freeze_gate_v2)<>'passed' then raise exception 'review_v5_freeze_stale'; end if;
  select id into v_id from public.full_corpus_review_jobs_v5
  where (status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at<now()))) and attempt_count<4 and (next_retry_at is null or next_retry_at<=now())
  order by created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.full_corpus_review_jobs_v5 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(600,coalesce(p_lease_seconds,420)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null where id=v_id;
  return query select * from public.full_corpus_review_jobs_v5 where id=v_id;
end $$;

create function public.get_full_corpus_review_job_input_v5(p_job_id uuid,p_lease_token uuid,p_pass_kind text)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.full_corpus_review_jobs_v5%rowtype;p record;v_articles jsonb;begin
  select * into j from public.full_corpus_review_jobs_v5 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'review_v5_job_lease_invalid'; end if;
  if p_pass_kind not in ('reviewer','critic') then raise exception 'review_v5_pass_kind_invalid'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'review_v5_freeze_stale'; end if;
  select * into p from public.review_batch_article_set_proof_v5(j.batch_id);
  if p.article_count<>j.article_count or p.article_set_fingerprint<>j.batch_article_set_fingerprint or p.batch_input_fingerprint<>j.batch_input_fingerprint then raise exception 'review_v5_batch_input_stale'; end if;
  select jsonb_agg(jsonb_build_object(
    'article_id',g.article_id,'headline',g.headline,'article_date',g.article_date,'source_region_id',g.source_region_id,
    'source_region_sha256',g.source_region_sha256,
    'blocks',(select jsonb_agg(jsonb_build_object('block_index',b.block_index,'text',b.block_text,'x_min',b.x_min,'y_min',b.y_min,'x_max',b.x_max,'y_max',b.y_max) order by b.x_min,b.y_min,b.block_index) from public.formal_source_grounded_article_blocks_v4 b where b.article_id=g.article_id and b.source_region_id=g.source_region_id),
    'coverage_targets',(select jsonb_agg(jsonb_build_object('anchor_slot',t.anchor_slot,'block_index',t.block_index,'block_text',t.block_text,'source_block_sha256',t.source_block_sha256) order by case t.anchor_slot when 'primary' then 1 when 'secondary' then 2 else 3 end) from public.source_region_coverage_targets_v4 t where t.article_id=g.article_id and t.source_region_id=g.source_region_id),
    'reviewer_output',case when p_pass_kind='critic' then (select rr.reviewer_json from public.full_corpus_reviewer_rows_v5 rr where rr.job_id=j.id and rr.article_id=g.article_id) else null end
  ) order by g.article_date nulls last,g.article_id) into v_articles
  from public.full_corpus_scan_batches b cross join lateral unnest(b.article_ids) u(article_id) join public.formal_source_grounded_articles_v4 g on g.article_id=u.article_id
  where b.id=j.batch_id;
  if p_pass_kind='critic' and (select count(*) from public.full_corpus_reviewer_rows_v5 where job_id=j.id)<>j.article_count then raise exception 'review_v5_critic_requires_complete_reviewer_rows'; end if;
  return jsonb_build_object('job',jsonb_build_object('job_id',j.id,'run_id',j.run_id,'batch_id',j.batch_id,'batch_index',j.batch_index,'article_count',j.article_count,'freeze_receipt_id',j.freeze_receipt_id,'batch_article_set_fingerprint',j.batch_article_set_fingerprint,'batch_input_fingerprint',j.batch_input_fingerprint,'lease_token',j.lease_token),'pass_kind',p_pass_kind,'articles',v_articles);
end $$;

create function public.store_full_corpus_review_pass_v5(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.full_corpus_review_jobs_v5%rowtype;v_count integer;v_distinct integer;v_other public.full_corpus_review_pass_runs_v5%rowtype;begin
  select * into j from public.full_corpus_review_jobs_v5 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'review_v5_job_lease_invalid'; end if;
  if p_pass_kind not in ('reviewer','critic') or coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'review_v5_pass_receipt_invalid'; end if;
  select * into v_other from public.full_corpus_review_pass_runs_v5 where job_id=j.id and pass_kind<>p_pass_kind;
  if found and (v_other.model=p_model or v_other.provider_response_id=p_provider_response_id or v_other.prompt_sha256=p_prompt_sha256) then raise exception 'review_v5_passes_must_be_independent'; end if;
  if jsonb_typeof(p_rows)<>'array' then raise exception 'review_v5_rows_must_be_array'; end if;
  select count(*)::integer,count(distinct article_id)::integer into v_count,v_distinct from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb);
  if v_count<>j.article_count or v_distinct<>j.article_count then raise exception 'review_v5_row_count_mismatch'; end if;
  if exists(
    with expected as (select unnest(article_ids) article_id from public.full_corpus_scan_batches where id=j.batch_id), supplied as (select article_id from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb))
    select 1 from ((select article_id from expected except select article_id from supplied) union all (select article_id from supplied except select article_id from expected)) d limit 1
  ) then raise exception 'review_v5_article_set_mismatch'; end if;

  if p_pass_kind='reviewer' then
    if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb) where not public.validate_reviewer_json_v5(x.article_id,x.result)) then raise exception 'review_v5_invalid_reviewer_row'; end if;
    delete from public.full_corpus_review_critic_rows_v5 where job_id=j.id;
    delete from public.full_corpus_reviewer_rows_v5 where job_id=j.id;
    insert into public.full_corpus_reviewer_rows_v5(job_id,article_id,reviewer_json,updated_at)
    select j.id,x.article_id,x.result,now() from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb);
  else
    if (select count(*) from public.full_corpus_reviewer_rows_v5 where job_id=j.id)<>j.article_count then raise exception 'review_v5_critic_requires_reviewer_pass'; end if;
    if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb) where (x.result->>'verdict') not in ('approved','rejected','unresolved') or coalesce((x.result->>'fact_supported')::boolean,false) is null or coalesce((x.result->>'coverage_complete')::boolean,false) is null or coalesce((x.result->>'no_theme_signal_valid')::boolean,false) is null or coalesce((x.result->>'seeds_grounded')::boolean,false) is null or coalesce((x.result->>'overclaim_risk')::boolean,false) is null) then raise exception 'review_v5_critic_row_invalid'; end if;
    delete from public.full_corpus_review_critic_rows_v5 where job_id=j.id;
    insert into public.full_corpus_review_critic_rows_v5(job_id,article_id,verdict,fact_supported,coverage_complete,no_theme_signal_valid,seeds_grounded,overclaim_risk,reason,updated_at)
    select j.id,x.article_id,x.result->>'verdict',(x.result->>'fact_supported')::boolean,(x.result->>'coverage_complete')::boolean,(x.result->>'no_theme_signal_valid')::boolean,(x.result->>'seeds_grounded')::boolean,(x.result->>'overclaim_risk')::boolean,left(coalesce(x.result->>'reason',''),1200),now()
    from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb);
  end if;

  insert into public.full_corpus_review_pass_runs_v5(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();
  return jsonb_build_object('status','stored','pass_kind',p_pass_kind,'row_count',v_count);
end $$;

alter table public.full_corpus_review_jobs_v5 enable row level security;alter table public.full_corpus_review_pass_runs_v5 enable row level security;alter table public.full_corpus_reviewer_rows_v5 enable row level security;alter table public.full_corpus_review_critic_rows_v5 enable row level security;
revoke all on table public.full_corpus_review_jobs_v5,public.full_corpus_review_pass_runs_v5,public.full_corpus_reviewer_rows_v5,public.full_corpus_review_critic_rows_v5 from anon,authenticated,service_role;
grant select on table public.full_corpus_review_jobs_v5,public.full_corpus_review_pass_runs_v5,public.full_corpus_reviewer_rows_v5,public.full_corpus_review_critic_rows_v5 to service_role;
revoke insert,update,delete,truncate,references,trigger on table public.full_corpus_article_reviews_v4,public.full_corpus_article_review_anchors_v4,public.full_corpus_theme_seeds_v4 from service_role;
grant select on table public.full_corpus_article_reviews_v4,public.full_corpus_article_review_anchors_v4,public.full_corpus_theme_seeds_v4 to service_role;
revoke execute on function public.review_batch_article_set_proof_v5(uuid) from public,anon,authenticated;revoke execute on function public.validate_reviewer_json_v5(uuid,jsonb) from public,anon,authenticated;revoke execute on function public.create_full_corpus_scan_run_v5(integer) from public,anon,authenticated;revoke execute on function public.claim_full_corpus_review_job_v5(integer) from public,anon,authenticated;revoke execute on function public.get_full_corpus_review_job_input_v5(uuid,uuid,text) from public,anon,authenticated;revoke execute on function public.store_full_corpus_review_pass_v5(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.review_batch_article_set_proof_v5(uuid) to service_role;grant execute on function public.validate_reviewer_json_v5(uuid,jsonb) to service_role;grant execute on function public.create_full_corpus_scan_run_v5(integer) to service_role;grant execute on function public.claim_full_corpus_review_job_v5(integer) to service_role;grant execute on function public.get_full_corpus_review_job_input_v5(uuid,uuid,text) to service_role;grant execute on function public.store_full_corpus_review_pass_v5(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
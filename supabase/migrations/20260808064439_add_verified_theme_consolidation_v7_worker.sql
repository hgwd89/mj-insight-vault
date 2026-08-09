begin;

create or replace function public.claim_verified_theme_consolidation_job_v7(p_lease_seconds integer default 240)
returns setof public.verified_theme_consolidation_jobs_v7
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  update public.verified_theme_consolidation_jobs_v7 j set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='consolidation lease expired too many times',finished_at=now(),updated_at=now()
   where status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3
     and exists(select 1 from public.verified_theme_analysis_runs_v7 a join public.current_verified_article_review_corpus_receipt_v7 r on r.id=a.review_receipt_id where a.id=j.analysis_run_id and a.status='consolidating');
  select j.id,j.status,
         case when not exists(select 1 from public.verified_theme_consolidation_passes_v7 p where p.job_id=j.id and p.pass_kind='consolidator') then 'consolidator'
              when not exists(select 1 from public.verified_theme_consolidation_passes_v7 p where p.job_id=j.id and p.pass_kind='critic') then 'critic' else null end
    into v_id,v_status,v_pass
  from public.verified_theme_consolidation_jobs_v7 j
  join public.verified_theme_analysis_runs_v7 a on a.id=j.analysis_run_id and a.status='consolidating'
  join public.current_verified_article_review_corpus_receipt_v7 r on r.id=a.review_receipt_id
  where (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now())) and j.failure_count<4
    and (not exists(select 1 from public.verified_theme_consolidation_passes_v7 p where p.job_id=j.id and p.pass_kind='consolidator') or not exists(select 1 from public.verified_theme_consolidation_passes_v7 p where p.job_id=j.id and p.pass_kind='critic'))
  order by j.created_at for update of j skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_theme_consolidation_jobs_v7 set status='running',active_pass_kind=v_pass,lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.verified_theme_consolidation_jobs_v7 where id=v_id;
end
$function$;

create or replace function public.get_verified_theme_consolidation_input_v7(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.verified_theme_consolidation_jobs_v7%rowtype;a public.verified_theme_analysis_runs_v7%rowtype;v_proposals jsonb;v_groups jsonb;v_n integer;v_fp text;
begin
  select * into j from public.verified_theme_consolidation_jobs_v7 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_theme_consolidation_v7_lease_invalid'; end if;
  select * into a from public.verified_theme_analysis_runs_v7 where id=j.analysis_run_id;
  if not exists(select 1 from public.current_verified_article_review_corpus_receipt_v7 r where r.id=a.review_receipt_id and r.seed_set_fingerprint=a.seed_set_fingerprint) then raise exception 'verified_theme_consolidation_v7_input_stale'; end if;
  select count(*)::integer,encode(extensions.digest(convert_to(coalesce(string_agg(p.id::text||':'||p.title||':'||p.definition||':'||p.scope_boundary||':'||p.subject||':'||p.measurement||':'||array_to_string(p.support_seed_ids,','),'|' order by p.id::text),''),'UTF8'),'sha256'),'hex'),
         jsonb_agg(jsonb_build_object('proposal_id',p.id,'title',p.title,'definition',p.definition,'scope_boundary',p.scope_boundary,'subject',p.subject,'measurement',p.measurement,'support_seed_count',cardinality(p.support_seed_ids)) order by p.id)
    into v_n,v_fp,v_proposals
  from public.verified_theme_candidate_proposals_v7 p join public.verified_theme_seed_chunk_jobs_v7 c on c.id=p.chunk_job_id where c.analysis_run_id=a.id;
  if v_n<>j.proposal_count or v_fp<>j.proposal_set_fingerprint then raise exception 'verified_theme_consolidation_v7_proposal_set_stale'; end if;
  if j.active_pass_kind='critic' then
    select result_json->'groups' into v_groups from public.verified_theme_consolidation_passes_v7 where job_id=j.id and pass_kind='consolidator';
    if jsonb_typeof(v_groups)<>'array' then raise exception 'verified_theme_consolidation_v7_critic_requires_groups'; end if;
  end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'analysis_run_id',j.analysis_run_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token,'proposal_count',j.proposal_count,'proposal_set_fingerprint',j.proposal_set_fingerprint),'proposals',v_proposals,'groups',v_groups);
end
$function$;

create or replace function public.finalize_verified_theme_consolidation_v7(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.verified_theme_consolidation_jobs_v7%rowtype;a public.verified_theme_analysis_runs_v7%rowtype;co jsonb;cr jsonb;v_groups integer;v_reviews integer;v_bad integer;v_pairs integer;v_fp text;
begin
  select * into j from public.verified_theme_consolidation_jobs_v7 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_theme_consolidation_v7_lease_invalid'; end if;
  select * into a from public.verified_theme_analysis_runs_v7 where id=j.analysis_run_id for update;
  if not exists(select 1 from public.current_verified_article_review_corpus_receipt_v7 r where r.id=a.review_receipt_id and r.seed_set_fingerprint=a.seed_set_fingerprint) then raise exception 'verified_theme_consolidation_v7_input_stale'; end if;
  select result_json into co from public.verified_theme_consolidation_passes_v7 where job_id=j.id and pass_kind='consolidator';
  select result_json into cr from public.verified_theme_consolidation_passes_v7 where job_id=j.id and pass_kind='critic';
  if co is null or cr is null then raise exception 'verified_theme_consolidation_v7_passes_incomplete'; end if;
  select count(*)::integer into v_groups from jsonb_array_elements(co->'groups');
  select count(*)::integer,count(*) filter(where not approved)::integer into v_reviews,v_bad from jsonb_to_recordset(cr->'group_reviews') x(group_key text,approved boolean,reason text);
  select count(*)::integer into v_pairs from jsonb_array_elements(cr->'cross_group_merge_pairs');
  if v_reviews<>v_groups or v_bad>0 or v_pairs>0 or not coalesce((cr->>'coverage_complete')::boolean,false) then
    update public.verified_theme_consolidation_jobs_v7 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='theme consolidation critic rejected grouping or found cross-group merges',updated_at=now() where id=j.id;
    update public.verified_theme_analysis_runs_v7 set status='needs_review',error_message='theme consolidation requires review',updated_at=now() where id=a.id;
    return jsonb_build_object('status','needs_review');
  end if;
  delete from public.verified_theme_candidates_v7 where analysis_run_id=a.id;
  insert into public.verified_theme_candidates_v7(analysis_run_id,theme_key,title,definition,inclusion_rule,exclusion_rule,subject,measurement,source_proposal_ids,support_seed_ids)
  select a.id,
         'theme_'||substr(encode(extensions.digest(convert_to(array_to_string(array(select x::uuid::text from unnest(g.proposal_ids) x order by x::uuid::text),'|'),'UTF8'),'sha256'),'hex'),1,16),
         left(g.title,300),left(g.definition,2400),left(g.inclusion_rule,1600),left(g.exclusion_rule,1600),g.subject,g.measurement,
         (select array_agg(x::uuid order by x::uuid::text) from unnest(g.proposal_ids) x),
         (select array_agg(distinct sid order by sid::text) from unnest(g.proposal_ids) pid join public.verified_theme_candidate_proposals_v7 p on p.id=pid::uuid cross join lateral unnest(p.support_seed_ids) sid)
  from jsonb_to_recordset(co->'groups') g(group_key text,title text,definition text,inclusion_rule text,exclusion_rule text,subject text,measurement text,proposal_ids uuid[])
  order by g.group_key;
  select encode(extensions.digest(convert_to(coalesce(string_agg(c.theme_key||':'||c.title||':'||c.definition||':'||c.inclusion_rule||':'||c.exclusion_rule||':'||c.subject||':'||c.measurement||':'||array_to_string(c.support_seed_ids,','),'|' order by c.theme_key),''),'UTF8'),'sha256'),'hex') into v_fp from public.verified_theme_candidates_v7 c where c.analysis_run_id=a.id;
  update public.verified_theme_analysis_runs_v7 set status='candidates_ready',candidate_set_fingerprint=v_fp,error_message=null,updated_at=now() where id=a.id;
  update public.verified_theme_consolidation_jobs_v7 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','candidate_count',(select count(*) from public.verified_theme_candidates_v7 where analysis_run_id=a.id),'candidate_set_fingerprint',v_fp);
end
$function$;

create or replace function public.store_verified_theme_consolidation_pass_v7(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_consolidation_jobs_v7%rowtype;o public.verified_theme_consolidation_passes_v7%rowtype;v_n integer;v_d integer;v_assigned integer;
begin
  select * into j from public.verified_theme_consolidation_jobs_v7 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_theme_consolidation_v7_lease_invalid'; end if;
  if p_pass_kind not in ('consolidator','critic') or j.active_pass_kind is distinct from p_pass_kind then raise exception 'verified_theme_consolidation_v7_pass_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' then raise exception 'verified_theme_consolidation_v7_receipt_or_result_invalid'; end if;
  select * into o from public.verified_theme_consolidation_passes_v7 where job_id=j.id and pass_kind<>p_pass_kind;
  if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_theme_consolidation_v7_independent_pass_required'; end if;
  if p_pass_kind='consolidator' then
    if jsonb_typeof(p_result->'groups')<>'array' or jsonb_array_length(p_result->'groups')=0 then raise exception 'verified_theme_consolidation_v7_groups_required'; end if;
    select count(*)::integer,count(distinct group_key)::integer into v_n,v_d from jsonb_to_recordset(p_result->'groups') g(group_key text,title text,definition text,inclusion_rule text,exclusion_rule text,subject text,measurement text,proposal_ids uuid[]);
    if v_n<>v_d then raise exception 'verified_theme_consolidation_v7_duplicate_group_key'; end if;
    if exists(select 1 from jsonb_to_recordset(p_result->'groups') g(group_key text,title text,definition text,inclusion_rule text,exclusion_rule text,subject text,measurement text,proposal_ids uuid[])
              where char_length(btrim(coalesce(g.group_key,'')))<1 or char_length(btrim(coalesce(g.title,'')))<2 or char_length(btrim(coalesce(g.definition,'')))<8 or char_length(btrim(coalesce(g.inclusion_rule,'')))<4 or char_length(btrim(coalesce(g.exclusion_rule,'')))<4
                 or g.subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear')
                 or g.measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')
                 or coalesce(cardinality(g.proposal_ids),0)<1
                 or exists(select 1 from unnest(g.proposal_ids) pid where not exists(select 1 from public.verified_theme_candidate_proposals_v7 p join public.verified_theme_seed_chunk_jobs_v7 c on c.id=p.chunk_job_id where p.id=pid and c.analysis_run_id=j.analysis_run_id))) then raise exception 'verified_theme_consolidation_v7_group_invalid'; end if;
    select count(*)::integer,count(distinct pid)::integer into v_n,v_assigned from jsonb_to_recordset(p_result->'groups') g(group_key text,title text,definition text,inclusion_rule text,exclusion_rule text,subject text,measurement text,proposal_ids uuid[]) cross join lateral unnest(g.proposal_ids) pid;
    if v_n<>j.proposal_count or v_assigned<>j.proposal_count then raise exception 'verified_theme_consolidation_v7_proposal_partition_incomplete'; end if;
    delete from public.verified_theme_consolidation_passes_v7 where job_id=j.id and pass_kind='critic';
  else
    if not exists(select 1 from public.verified_theme_consolidation_passes_v7 where job_id=j.id and pass_kind='consolidator') then raise exception 'verified_theme_consolidation_v7_critic_requires_consolidator'; end if;
    if jsonb_typeof(p_result->'group_reviews')<>'array' or jsonb_typeof(p_result->'cross_group_merge_pairs')<>'array' or jsonb_typeof(p_result->'coverage_complete')<>'boolean' then raise exception 'verified_theme_consolidation_v7_critic_schema_invalid'; end if;
  end if;
  insert into public.verified_theme_consolidation_passes_v7(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='critic' then return public.finalize_verified_theme_consolidation_v7(j.id,j.lease_token); end if;
  update public.verified_theme_consolidation_jobs_v7 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','completed_stage','consolidator');
end
$function$;

create or replace function public.fail_verified_theme_consolidation_job_v7(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_consolidation_jobs_v7%rowtype;v_n integer;v_next text;
begin
 select * into j from public.verified_theme_consolidation_jobs_v7 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'verified_theme_consolidation_v7_lease_invalid'; end if;
 v_n:=j.failure_count+1;v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_n<4 then 'queued' else 'failed' end;
 update public.verified_theme_consolidation_jobs_v7 set status=v_next,failure_count=v_n,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'theme consolidation worker failed'),3000),finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=j.id;
 if v_next in ('needs_review','failed') then update public.verified_theme_analysis_runs_v7 set status='needs_review',error_message=left(coalesce(p_error,'theme consolidation failed'),3000),updated_at=now() where id=j.analysis_run_id; end if;
 return jsonb_build_object('status',v_next,'failure_count',v_n,'retry_scheduled',(v_next='queued'));
end
$function$;

revoke all on function public.claim_verified_theme_consolidation_job_v7(integer) from public,anon,authenticated;
revoke all on function public.get_verified_theme_consolidation_input_v7(uuid,uuid) from public,anon,authenticated;
revoke all on function public.store_verified_theme_consolidation_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_verified_theme_consolidation_v7(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_verified_theme_consolidation_job_v7(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_verified_theme_consolidation_job_v7(integer) to service_role;
grant execute on function public.get_verified_theme_consolidation_input_v7(uuid,uuid) to service_role;
grant execute on function public.store_verified_theme_consolidation_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.finalize_verified_theme_consolidation_v7(uuid,uuid) to service_role;
grant execute on function public.fail_verified_theme_consolidation_job_v7(uuid,uuid,text,boolean) to service_role;

commit;
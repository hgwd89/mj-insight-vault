begin;

create or replace function public.create_verified_theme_analysis_run_v7(p_seed_chunk_size integer default 40)
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare v_receipt public.verified_article_review_corpus_receipts_v7%rowtype;v_run uuid;v_size integer:=greatest(20,least(60,coalesce(p_seed_chunk_size,40)));v_empty_fp text;
begin
  if (select review_gate from public.verified_article_review_gate_v6)<>'passed' then raise exception 'verified_theme_v7_review_gate_required'; end if;
  perform public.record_verified_article_review_corpus_receipt_v7();
  select * into v_receipt from public.current_verified_article_review_corpus_receipt_v7;
  if v_receipt.id is null then raise exception 'verified_theme_v7_review_receipt_missing'; end if;
  insert into public.verified_theme_analysis_runs_v7(review_receipt_id,seed_count,review_set_fingerprint,seed_set_fingerprint)
  values(v_receipt.id,v_receipt.seed_count,v_receipt.review_set_fingerprint,v_receipt.seed_set_fingerprint)
  on conflict(review_receipt_id) do update set review_set_fingerprint=excluded.review_set_fingerprint,seed_set_fingerprint=excluded.seed_set_fingerprint,seed_count=excluded.seed_count,updated_at=now()
  returning id into v_run;
  if v_receipt.seed_count=0 then
    v_empty_fp:=encode(extensions.digest(convert_to('','UTF8'),'sha256'),'hex');
    update public.verified_theme_analysis_runs_v7 set status='candidates_ready',candidate_set_fingerprint=v_empty_fp,error_message=null,updated_at=now() where id=v_run;
    return v_run;
  end if;
  if not exists(select 1 from public.verified_theme_seed_chunk_jobs_v7 where analysis_run_id=v_run) then
    with seed_source as (
      select s.id,s.seed_label,s.seed_statement,s.subject,s.measurement,s.confidence,s.source_anchor,
             row_number() over(order by s.id) rn
      from public.verified_article_theme_seeds_v6 s
      join public.verified_article_reviews_v6 ar on ar.id=s.review_id
      where ar.classification_receipt_id=v_receipt.classification_receipt_id
    ), chunks as (
      select ((rn-1)/v_size+1)::integer chunk_index,
             array_agg(id order by id) seed_ids,
             count(*)::integer seed_count,
             encode(extensions.digest(convert_to(string_agg(id::text||':'||seed_label||':'||seed_statement||':'||subject||':'||measurement||':'||confidence::text||':'||source_anchor,'|' order by id),'UTF8'),'sha256'),'hex') fp
      from seed_source group by ((rn-1)/v_size+1)::integer
    )
    insert into public.verified_theme_seed_chunk_jobs_v7(analysis_run_id,chunk_index,seed_ids,seed_count,seed_chunk_fingerprint)
    select v_run,chunk_index,seed_ids,seed_count,fp from chunks order by chunk_index;
  end if;
  return v_run;
end
$function$;

create or replace function public.claim_verified_theme_seed_chunk_job_v7(p_lease_seconds integer default 240)
returns setof public.verified_theme_seed_chunk_jobs_v7
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_run uuid;v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  select a.id into v_run from public.verified_theme_analysis_runs_v7 a join public.current_verified_article_review_corpus_receipt_v7 r on r.id=a.review_receipt_id where a.status='discovering' order by a.created_at desc limit 1;
  if v_run is null then return; end if;
  update public.verified_theme_seed_chunk_jobs_v7 set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='seed chunk lease expired too many times',finished_at=now(),updated_at=now()
   where analysis_run_id=v_run and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;
  select j.id,j.status,
         case when not exists(select 1 from public.verified_theme_seed_chunk_passes_v7 p where p.job_id=j.id and p.pass_kind='synthesizer') then 'synthesizer'
              when not exists(select 1 from public.verified_theme_seed_chunk_passes_v7 p where p.job_id=j.id and p.pass_kind='critic') then 'critic' else null end
    into v_id,v_status,v_pass
  from public.verified_theme_seed_chunk_jobs_v7 j
  where j.analysis_run_id=v_run and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now())) and j.failure_count<4
    and (not exists(select 1 from public.verified_theme_seed_chunk_passes_v7 p where p.job_id=j.id and p.pass_kind='synthesizer') or not exists(select 1 from public.verified_theme_seed_chunk_passes_v7 p where p.job_id=j.id and p.pass_kind='critic'))
  order by j.chunk_index for update skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_theme_seed_chunk_jobs_v7 set status='running',active_pass_kind=v_pass,lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.verified_theme_seed_chunk_jobs_v7 where id=v_id;
end
$function$;

create or replace function public.get_verified_theme_seed_chunk_input_v7(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_seed_chunk_jobs_v7%rowtype;a public.verified_theme_analysis_runs_v7%rowtype;v_seeds jsonb;v_proposals jsonb;
begin
  select * into j from public.verified_theme_seed_chunk_jobs_v7 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_theme_chunk_v7_lease_invalid'; end if;
  select * into a from public.verified_theme_analysis_runs_v7 where id=j.analysis_run_id;
  if not exists(select 1 from public.current_verified_article_review_corpus_receipt_v7 r where r.id=a.review_receipt_id and r.seed_set_fingerprint=a.seed_set_fingerprint) then raise exception 'verified_theme_chunk_v7_input_stale'; end if;
  select jsonb_agg(jsonb_build_object('seed_id',s.id,'article_id',s.article_id,'seed_label',s.seed_label,'seed_statement',s.seed_statement,'subject',s.subject,'measurement',s.measurement,'confidence',s.confidence,'source_anchor',s.source_anchor) order by s.id)
    into v_seeds from public.verified_article_theme_seeds_v6 s where s.id=any(j.seed_ids);
  if coalesce(jsonb_array_length(v_seeds),0)<>j.seed_count then raise exception 'verified_theme_chunk_v7_seed_set_stale'; end if;
  if j.active_pass_kind='critic' then
    select jsonb_agg(jsonb_build_object('proposal_id',p.id,'proposal_key',p.proposal_key,'title',p.title,'definition',p.definition,'scope_boundary',p.scope_boundary,'subject',p.subject,'measurement',p.measurement,'support_seed_ids',p.support_seed_ids) order by p.proposal_key)
      into v_proposals from public.verified_theme_candidate_proposals_v7 p where p.chunk_job_id=j.id;
    if coalesce(jsonb_array_length(v_proposals),0)=0 then raise exception 'verified_theme_chunk_v7_critic_requires_proposals'; end if;
  end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'analysis_run_id',j.analysis_run_id,'chunk_index',j.chunk_index,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token,'seed_count',j.seed_count,'seed_chunk_fingerprint',j.seed_chunk_fingerprint),'seeds',v_seeds,'proposals',v_proposals);
end
$function$;

create or replace function public.prepare_verified_theme_consolidation_v7(p_analysis_run_id uuid)
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare a public.verified_theme_analysis_runs_v7%rowtype;v_jobs integer;v_done integer;v_bad integer;v_n integer;v_fp text;v_id uuid;
begin
  select * into a from public.verified_theme_analysis_runs_v7 where id=p_analysis_run_id for update;
  if not found or a.status not in ('discovering','consolidating') then raise exception 'verified_theme_consolidation_v7_run_invalid'; end if;
  select count(*)::integer,count(*) filter(where status='completed')::integer,count(*) filter(where status in ('needs_review','failed'))::integer into v_jobs,v_done,v_bad from public.verified_theme_seed_chunk_jobs_v7 where analysis_run_id=a.id;
  if v_bad>0 then update public.verified_theme_analysis_runs_v7 set status='needs_review',error_message='one or more seed chunks require review',updated_at=now() where id=a.id; return null; end if;
  if v_jobs=0 or v_done<>v_jobs then return null; end if;
  select count(*)::integer,encode(extensions.digest(convert_to(coalesce(string_agg(p.id::text||':'||p.title||':'||p.definition||':'||p.scope_boundary||':'||p.subject||':'||p.measurement||':'||array_to_string(p.support_seed_ids,','),'|' order by p.id::text),''),'UTF8'),'sha256'),'hex') into v_n,v_fp from public.verified_theme_candidate_proposals_v7 p join public.verified_theme_seed_chunk_jobs_v7 j on j.id=p.chunk_job_id where j.analysis_run_id=a.id;
  if v_n<=0 then raise exception 'verified_theme_consolidation_v7_no_proposals'; end if;
  insert into public.verified_theme_consolidation_jobs_v7(analysis_run_id,proposal_count,proposal_set_fingerprint)
  values(a.id,v_n,v_fp) on conflict(analysis_run_id) do update set proposal_count=excluded.proposal_count,proposal_set_fingerprint=excluded.proposal_set_fingerprint,updated_at=now() returning id into v_id;
  update public.verified_theme_analysis_runs_v7 set status='consolidating',error_message=null,updated_at=now() where id=a.id;
  return v_id;
end
$function$;

create or replace function public.fail_verified_theme_seed_chunk_job_v7(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_seed_chunk_jobs_v7%rowtype;v_n integer;v_next text;
begin
 select * into j from public.verified_theme_seed_chunk_jobs_v7 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'verified_theme_chunk_v7_lease_invalid'; end if;
 v_n:=j.failure_count+1;v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_n<4 then 'queued' else 'failed' end;
 update public.verified_theme_seed_chunk_jobs_v7 set status=v_next,failure_count=v_n,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'theme chunk worker failed'),3000),finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=j.id;
 return jsonb_build_object('status',v_next,'failure_count',v_n,'retry_scheduled',(v_next='queued'));
end
$function$;

revoke all on function public.create_verified_theme_analysis_run_v7(integer) from public,anon,authenticated;
revoke all on function public.claim_verified_theme_seed_chunk_job_v7(integer) from public,anon,authenticated;
revoke all on function public.get_verified_theme_seed_chunk_input_v7(uuid,uuid) from public,anon,authenticated;
revoke all on function public.prepare_verified_theme_consolidation_v7(uuid) from public,anon,authenticated;
revoke all on function public.fail_verified_theme_seed_chunk_job_v7(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.create_verified_theme_analysis_run_v7(integer) to service_role;
grant execute on function public.claim_verified_theme_seed_chunk_job_v7(integer) to service_role;
grant execute on function public.get_verified_theme_seed_chunk_input_v7(uuid,uuid) to service_role;
grant execute on function public.prepare_verified_theme_consolidation_v7(uuid) to service_role;
grant execute on function public.fail_verified_theme_seed_chunk_job_v7(uuid,uuid,text,boolean) to service_role;

commit;
begin;

create or replace function public.claim_verified_theme_report_final_job_v8(p_lease_seconds integer default 240)
returns setof public.verified_theme_report_final_jobs_v8
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  update public.verified_theme_report_final_jobs_v8 j set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='final report lease expired too many times',finished_at=now(),updated_at=now()
  where status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3
    and exists(select 1 from public.verified_theme_report_runs_v8 r join public.current_verified_theme_analysis_proof_v8 p on p.id=r.analysis_proof_receipt_id where r.id=j.run_id and r.status='finalizing');
  select j.id,j.status,
         case when not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') then 'generator'
              when not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='critic') then 'critic' else null end
  into v_id,v_status,v_pass
  from public.verified_theme_report_final_jobs_v8 j
  join public.verified_theme_report_runs_v8 r on r.id=j.run_id and r.status='finalizing'
  join public.current_verified_theme_analysis_proof_v8 p on p.id=r.analysis_proof_receipt_id
  where (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now())) and j.failure_count<4
    and (not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') or not exists(select 1 from public.verified_theme_report_final_passes_v8 p where p.job_id=j.id and p.pass_kind='critic'))
  order by j.created_at for update of j skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_theme_report_final_jobs_v8 set status='running',active_pass_kind=v_pass,lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.verified_theme_report_final_jobs_v8 where id=v_id;
end
$function$;

create or replace function public.get_verified_theme_report_final_input_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.verified_theme_report_final_jobs_v8%rowtype;r public.verified_theme_report_runs_v8%rowtype;v_fp text;v_notes jsonb;v_metrics jsonb;v_gen jsonb;
begin
  select * into j from public.verified_theme_report_final_jobs_v8 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_final_v8_lease_invalid'; end if;
  select * into r from public.verified_theme_report_runs_v8 where id=j.run_id;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=r.analysis_proof_receipt_id) then raise exception 'verified_report_final_v8_proof_stale'; end if;
  select encode(extensions.digest(convert_to(coalesce(string_agg(n.candidate_id::text||':'||n.interpretation||':'||n.trajectory_interpretation||':'||n.limitation||':'||array_to_string(n.evidence_article_ids,','),'|' order by n.candidate_id::text),''),'UTF8'),'sha256'),'hex'),
         jsonb_agg(jsonb_build_object('candidate_id',n.candidate_id,'interpretation',n.interpretation,'trajectory_interpretation',n.trajectory_interpretation,'limitation',n.limitation,'evidence_article_ids',n.evidence_article_ids) order by n.candidate_id)
    into v_fp,v_notes from public.verified_theme_report_notes_v8 n where n.run_id=r.id;
  if v_fp<>j.note_set_fingerprint or coalesce(jsonb_array_length(v_notes),0)<>r.candidate_count then raise exception 'verified_report_final_v8_note_set_stale'; end if;
  select jsonb_agg(to_jsonb(m) order by m.candidate_id) into v_metrics from public.verified_theme_metrics_v8 m;
  if coalesce(jsonb_array_length(v_metrics),0)<>r.candidate_count then raise exception 'verified_report_final_v8_metric_set_stale'; end if;
  if j.active_pass_kind='critic' then select result_json into v_gen from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='generator';if v_gen is null then raise exception 'verified_report_final_v8_critic_requires_generator';end if;end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'run_id',j.run_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token,'note_set_fingerprint',j.note_set_fingerprint),'theme_metrics',v_metrics,'theme_notes',v_notes,'generator_output',v_gen);
end
$function$;

create or replace function public.finalize_verified_theme_report_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.verified_theme_report_final_jobs_v8%rowtype;r public.verified_theme_report_runs_v8%rowtype;g public.verified_theme_report_final_passes_v8%rowtype;c public.verified_theme_report_final_passes_v8%rowtype;v_metrics jsonb;v_notes jsonb;v_fp text;v_report uuid;
begin
  select * into j from public.verified_theme_report_final_jobs_v8 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_final_v8_lease_invalid'; end if;
  select * into r from public.verified_theme_report_runs_v8 where id=j.run_id for update;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=r.analysis_proof_receipt_id) then raise exception 'verified_report_final_v8_proof_stale'; end if;
  select * into g from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='generator';select * into c from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='critic';
  if g.job_id is null or c.job_id is null or g.model=c.model or g.provider_response_id=c.provider_response_id or g.prompt_sha256=c.prompt_sha256 then raise exception 'verified_report_final_v8_independent_passes_required'; end if;
  if not coalesce((c.result_json->>'approved')::boolean,false) or not coalesce((c.result_json->>'coverage_complete')::boolean,false) or not coalesce((c.result_json->>'metrics_consistent')::boolean,false) or not coalesce((c.result_json->>'evidence_scope_valid')::boolean,false) or coalesce((c.result_json->>'overclaim_risk')::boolean,true) then
    update public.verified_theme_report_final_jobs_v8 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(c.result_json->>'reason','final report critic did not approve'),2000),updated_at=now() where id=j.id;
    update public.verified_theme_report_runs_v8 set status='needs_review',error_message='final report critic did not approve',updated_at=now() where id=r.id;
    return jsonb_build_object('status','needs_review');
  end if;
  select jsonb_agg(to_jsonb(m) order by m.candidate_id) into v_metrics from public.verified_theme_metrics_v8 m;
  select jsonb_agg(jsonb_build_object('candidate_id',n.candidate_id,'interpretation',n.interpretation,'trajectory_interpretation',n.trajectory_interpretation,'limitation',n.limitation,'evidence_article_ids',n.evidence_article_ids) order by n.candidate_id) into v_notes from public.verified_theme_report_notes_v8 n where n.run_id=r.id;
  v_fp:=encode(extensions.digest(convert_to(r.analysis_proof_receipt_id::text||'|'||(g.result_json->>'executive_summary')||'|'||coalesce((g.result_json->'cross_theme_observations')::text,'[]')||'|'||coalesce((g.result_json->'major_theme_ids')::text,'[]')||'|'||coalesce(v_metrics::text,'[]')||'|'||coalesce(v_notes::text,'[]'),'UTF8'),'sha256'),'hex');
  insert into public.verified_theme_reports_v8(run_id,analysis_proof_receipt_id,executive_summary,cross_theme_observations,major_theme_ids,methodology_note,theme_metrics_json,theme_notes_json,report_fingerprint,updated_at)
  values(r.id,r.analysis_proof_receipt_id,g.result_json->>'executive_summary',g.result_json->'cross_theme_observations',array(select x::uuid from jsonb_array_elements_text(g.result_json->'major_theme_ids') x),'記事単位の原画像由来OCRを独立検証し、全記事レビュー、全seed候補化、全候補の全記事センサス、決定論的月次集計を経た結果のみを使用。数値指標はDB計算値であり生成AIに生成させない。',v_metrics,v_notes,v_fp,now())
  on conflict(run_id) do update set executive_summary=excluded.executive_summary,cross_theme_observations=excluded.cross_theme_observations,major_theme_ids=excluded.major_theme_ids,methodology_note=excluded.methodology_note,theme_metrics_json=excluded.theme_metrics_json,theme_notes_json=excluded.theme_notes_json,report_fingerprint=excluded.report_fingerprint,updated_at=now()
  returning id into v_report;
  update public.verified_theme_report_final_jobs_v8 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  update public.verified_theme_report_runs_v8 set status='completed',error_message=null,finished_at=now(),updated_at=now() where id=r.id;
  return jsonb_build_object('status','completed','report_id',v_report,'report_fingerprint',v_fp);
end
$function$;

create or replace function public.store_verified_theme_report_final_pass_v8(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_report_final_jobs_v8%rowtype;r public.verified_theme_report_runs_v8%rowtype;o public.verified_theme_report_final_passes_v8%rowtype;v_n integer;v_d integer;
begin
  select * into j from public.verified_theme_report_final_jobs_v8 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_final_v8_lease_invalid'; end if;
  select * into r from public.verified_theme_report_runs_v8 where id=j.run_id;
  if p_pass_kind not in ('generator','critic') or j.active_pass_kind is distinct from p_pass_kind then raise exception 'verified_report_final_v8_pass_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' then raise exception 'verified_report_final_v8_receipt_or_result_invalid'; end if;
  select * into o from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind<>p_pass_kind;if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_report_final_v8_independent_pass_required';end if;
  if p_pass_kind='generator' then
    if char_length(btrim(coalesce(p_result->>'executive_summary','')))<12 or jsonb_typeof(p_result->'major_theme_ids')<>'array' or jsonb_typeof(p_result->'coverage_candidate_ids')<>'array' or jsonb_typeof(p_result->'cross_theme_observations')<>'array' then raise exception 'verified_report_final_v8_generator_schema_invalid'; end if;
    if (p_result->>'executive_summary') ~ '[0-9０-９]' or exists(select 1 from jsonb_to_recordset(p_result->'cross_theme_observations') x(candidate_ids uuid[],statement text,limitation text) where x.statement ~ '[0-9０-９]' or x.limitation ~ '[0-9０-９]' or cardinality(x.candidate_ids)<2 or char_length(btrim(coalesce(x.statement,'')))<8 or char_length(btrim(coalesce(x.limitation,'')))<4) then raise exception 'verified_report_final_v8_freeform_numbers_or_observation_invalid'; end if;
    select count(*)::integer,count(distinct x)::integer into v_n,v_d from jsonb_array_elements_text(p_result->'coverage_candidate_ids') x;if v_n<>r.candidate_count or v_d<>r.candidate_count then raise exception 'verified_report_final_v8_coverage_candidate_count_invalid';end if;
    if exists((select c.id::text from public.verified_theme_candidates_v7 c where c.analysis_run_id=r.analysis_run_id except select x from jsonb_array_elements_text(p_result->'coverage_candidate_ids') x) union all (select x from jsonb_array_elements_text(p_result->'coverage_candidate_ids') x except select c.id::text from public.verified_theme_candidates_v7 c where c.analysis_run_id=r.analysis_run_id)) then raise exception 'verified_report_final_v8_coverage_candidate_set_mismatch';end if;
    select count(*)::integer,count(distinct x)::integer into v_n,v_d from jsonb_array_elements_text(p_result->'major_theme_ids') x;if v_n<>v_d then raise exception 'verified_report_final_v8_duplicate_major_theme';end if;
    if exists(select 1 from jsonb_array_elements_text(p_result->'major_theme_ids') x left join public.verified_theme_metrics_v8 m on m.candidate_id=x::uuid where m.candidate_id is null or m.support_article_count<=0) then raise exception 'verified_report_final_v8_major_theme_invalid';end if;
    if exists(select 1 from jsonb_to_recordset(p_result->'cross_theme_observations') x(candidate_ids uuid[],statement text,limitation text) cross join lateral unnest(x.candidate_ids) cid where not exists(select 1 from public.verified_theme_candidates_v7 c where c.analysis_run_id=r.analysis_run_id and c.id=cid)) then raise exception 'verified_report_final_v8_observation_candidate_invalid';end if;
    delete from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='critic';
  else
    if not exists(select 1 from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='generator') then raise exception 'verified_report_final_v8_critic_requires_generator';end if;
    if jsonb_typeof(p_result->'approved')<>'boolean' or jsonb_typeof(p_result->'coverage_complete')<>'boolean' or jsonb_typeof(p_result->'metrics_consistent')<>'boolean' or jsonb_typeof(p_result->'evidence_scope_valid')<>'boolean' or jsonb_typeof(p_result->'overclaim_risk')<>'boolean' or char_length(btrim(coalesce(p_result->>'reason','')))<4 then raise exception 'verified_report_final_v8_critic_schema_invalid';end if;
  end if;
  insert into public.verified_theme_report_final_passes_v8(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='critic' then return public.finalize_verified_theme_report_v8(j.id,j.lease_token);end if;
  update public.verified_theme_report_final_jobs_v8 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','completed_stage','generator');
end
$function$;

create or replace function public.fail_verified_theme_report_final_job_v8(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_report_final_jobs_v8%rowtype;v_n integer;v_next text;
begin select * into j from public.verified_theme_report_final_jobs_v8 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'verified_report_final_v8_lease_invalid';end if;v_n:=j.failure_count+1;v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_n<4 then 'queued' else 'failed' end;update public.verified_theme_report_final_jobs_v8 set status=v_next,failure_count=v_n,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'final report failed'),3000),finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=j.id;if v_next in ('needs_review','failed') then update public.verified_theme_report_runs_v8 set status='needs_review',error_message=left(coalesce(p_error,'final report failed'),3000),updated_at=now() where id=j.run_id;end if;return jsonb_build_object('status',v_next,'failure_count',v_n,'retry_scheduled',(v_next='queued'));end
$function$;

create view public.verified_theme_report_gate_v8
with (security_invoker=true)
as
with p as (select * from public.current_verified_theme_analysis_proof_v8),r as (select rr.* from public.verified_theme_report_runs_v8 rr join p on p.id=rr.analysis_proof_receipt_id order by rr.created_at desc limit 1),f as (select count(*)::integer n from public.verified_theme_reports_v8 x join r on r.id=x.run_id)
select p.id analysis_proof_receipt_id,r.id report_run_id,coalesce(r.candidate_count,0)::integer candidate_count,r.status report_run_status,coalesce(f.n,0)::integer report_count,
 case when p.id is not null and r.status='completed' and f.n=1 then 'passed' else 'failed' end report_gate,
 case when p.id is null then 'verified_theme_analysis_proof_required' when r.id is null then 'verified_theme_report_run_required' when r.status='needs_review' then 'verified_theme_report_needs_review' when r.status='failed' then 'verified_theme_report_failed' when r.status<>'completed' or f.n<>1 then 'verified_theme_report_incomplete' else 'passed' end gate_reason
from (select 1) q left join p on true left join r on true left join f on true;
revoke all on public.verified_theme_report_gate_v8 from public,anon,authenticated;
grant select on public.verified_theme_report_gate_v8 to service_role;

revoke all on function public.claim_verified_theme_report_final_job_v8(integer) from public,anon,authenticated;
revoke all on function public.get_verified_theme_report_final_input_v8(uuid,uuid) from public,anon,authenticated;
revoke all on function public.store_verified_theme_report_final_pass_v8(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_verified_theme_report_v8(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_verified_theme_report_final_job_v8(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_verified_theme_report_final_job_v8(integer) to service_role;
grant execute on function public.get_verified_theme_report_final_input_v8(uuid,uuid) to service_role;
grant execute on function public.store_verified_theme_report_final_pass_v8(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.finalize_verified_theme_report_v8(uuid,uuid) to service_role;
grant execute on function public.fail_verified_theme_report_final_job_v8(uuid,uuid,text,boolean) to service_role;
commit;
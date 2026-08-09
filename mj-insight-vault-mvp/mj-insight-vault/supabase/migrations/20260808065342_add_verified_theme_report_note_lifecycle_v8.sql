begin;

create or replace function public.create_verified_theme_report_run_v8()
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare v_proof uuid;v_analysis uuid;v_n integer;v_run uuid;v_fp text;
begin
  if (select analysis_gate from public.verified_theme_analysis_gate_v8)<>'passed' then raise exception 'verified_report_v8_analysis_proof_required'; end if;
  v_proof:=public.record_verified_theme_analysis_proof_v8();
  select analysis_run_id,candidate_count into v_analysis,v_n from public.verified_theme_analysis_proof_receipts_v8 where id=v_proof;
  insert into public.verified_theme_report_runs_v8(analysis_proof_receipt_id,analysis_run_id,candidate_count)
  values(v_proof,v_analysis,v_n) on conflict(analysis_proof_receipt_id) do update set analysis_run_id=excluded.analysis_run_id,candidate_count=excluded.candidate_count,updated_at=now() returning id into v_run;
  if v_n=0 then
    v_fp:=encode(extensions.digest(convert_to(v_proof::text||'|no_defensible_theme_candidates','UTF8'),'sha256'),'hex');
    insert into public.verified_theme_reports_v8(run_id,analysis_proof_receipt_id,executive_summary,cross_theme_observations,major_theme_ids,methodology_note,theme_metrics_json,theme_notes_json,report_fingerprint,updated_at)
    values(v_run,v_proof,'検証済み記事全件のレビューと全コーパス・センサスの結果、正式なテーマ候補として残るものはありませんでした。','[]'::jsonb,'{}'::uuid[],'記事単位の検証済みOCR、独立レビュー、全候補センサス、決定論的集計に基づく。テーマ候補がゼロの場合は生成AIによる補完を行わない。','[]'::jsonb,'[]'::jsonb,v_fp,now())
    on conflict(run_id) do update set executive_summary=excluded.executive_summary,cross_theme_observations=excluded.cross_theme_observations,major_theme_ids=excluded.major_theme_ids,methodology_note=excluded.methodology_note,theme_metrics_json=excluded.theme_metrics_json,theme_notes_json=excluded.theme_notes_json,report_fingerprint=excluded.report_fingerprint,updated_at=now();
    update public.verified_theme_report_runs_v8 set status='completed',finished_at=now(),error_message=null,updated_at=now() where id=v_run;
    return v_run;
  end if;
  insert into public.verified_theme_report_note_jobs_v8(run_id,candidate_id)
  select v_run,c.id from public.verified_theme_candidates_v7 c where c.analysis_run_id=v_analysis
  on conflict(run_id,candidate_id) do nothing;
  return v_run;
end
$function$;

create or replace function public.claim_verified_theme_report_note_job_v8(p_lease_seconds integer default 240)
returns setof public.verified_theme_report_note_jobs_v8
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_run uuid;v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  select rr.id into v_run from public.verified_theme_report_runs_v8 rr join public.current_verified_theme_analysis_proof_v8 p on p.id=rr.analysis_proof_receipt_id where rr.status='notes' order by rr.created_at desc limit 1;
  if v_run is null then return; end if;
  update public.verified_theme_report_note_jobs_v8 set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='report note lease expired too many times',finished_at=now(),updated_at=now()
  where run_id=v_run and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;
  select j.id,j.status,
         case when not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') then 'generator'
              when not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='critic') then 'critic' else null end
    into v_id,v_status,v_pass
  from public.verified_theme_report_note_jobs_v8 j
  where j.run_id=v_run and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now())) and j.failure_count<4
    and (not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='generator') or not exists(select 1 from public.verified_theme_report_note_passes_v8 p where p.job_id=j.id and p.pass_kind='critic'))
  order by j.candidate_id for update skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_theme_report_note_jobs_v8 set status='running',active_pass_kind=v_pass,lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.verified_theme_report_note_jobs_v8 where id=v_id;
end
$function$;

create or replace function public.get_verified_theme_report_note_input_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_report_note_jobs_v8%rowtype;rr public.verified_theme_report_runs_v8%rowtype;v_metric jsonb;v_evidence jsonb;v_generator jsonb;
begin
  select * into j from public.verified_theme_report_note_jobs_v8 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_note_v8_lease_invalid'; end if;
  select * into rr from public.verified_theme_report_runs_v8 where id=j.run_id;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=rr.analysis_proof_receipt_id) then raise exception 'verified_report_note_v8_proof_stale'; end if;
  select to_jsonb(m) into v_metric from public.verified_theme_metrics_v8 m where m.candidate_id=j.candidate_id;
  if v_metric is null then raise exception 'verified_report_note_v8_metric_missing'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('article_id',e.article_id,'article_date',e.article_date,'mapping_confidence',e.mapping_confidence,'evidence_roles',e.evidence_roles,'mapper_source_anchor',e.mapper_source_anchor,'critic_source_anchor',e.critic_source_anchor,'verified_crop_ocr_text',v.analysis_text) order by e.article_id),'[]'::jsonb)
    into v_evidence from public.verified_theme_deterministic_evidence_v8 e join public.formal_verified_article_text_v5 v on v.article_id=e.article_id where e.candidate_id=j.candidate_id;
  if j.active_pass_kind='critic' then select result_json into v_generator from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind='generator'; if v_generator is null then raise exception 'verified_report_note_v8_critic_requires_generator'; end if; end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'run_id',j.run_id,'candidate_id',j.candidate_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token),'metric',v_metric,'deterministic_evidence',v_evidence,'generator_output',v_generator);
end
$function$;

create or replace function public.prepare_verified_theme_report_final_v8(p_run_id uuid)
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare rr public.verified_theme_report_runs_v8%rowtype;v_jobs integer;v_done integer;v_bad integer;v_notes integer;v_fp text;v_id uuid;
begin
  select * into rr from public.verified_theme_report_runs_v8 where id=p_run_id for update;
  if not found or rr.status not in ('notes','finalizing') then return null; end if;
  select count(*)::integer,count(*) filter(where status='completed')::integer,count(*) filter(where status in ('needs_review','failed'))::integer into v_jobs,v_done,v_bad from public.verified_theme_report_note_jobs_v8 where run_id=rr.id;
  if v_bad>0 then update public.verified_theme_report_runs_v8 set status='needs_review',error_message='one or more theme report notes require review',updated_at=now() where id=rr.id; return null; end if;
  select count(*)::integer,encode(extensions.digest(convert_to(coalesce(string_agg(n.candidate_id::text||':'||n.interpretation||':'||n.trajectory_interpretation||':'||n.limitation||':'||array_to_string(n.evidence_article_ids,','),'|' order by n.candidate_id::text),''),'UTF8'),'sha256'),'hex') into v_notes,v_fp from public.verified_theme_report_notes_v8 n where n.run_id=rr.id;
  if v_jobs<>rr.candidate_count or v_done<>rr.candidate_count or v_notes<>rr.candidate_count then return null; end if;
  insert into public.verified_theme_report_final_jobs_v8(run_id,note_set_fingerprint) values(rr.id,v_fp) on conflict(run_id) do update set note_set_fingerprint=excluded.note_set_fingerprint,updated_at=now() returning id into v_id;
  update public.verified_theme_report_runs_v8 set status='finalizing',error_message=null,updated_at=now() where id=rr.id;
  return v_id;
end
$function$;

create or replace function public.fail_verified_theme_report_note_job_v8(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_report_note_jobs_v8%rowtype;v_n integer;v_next text;
begin select * into j from public.verified_theme_report_note_jobs_v8 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'verified_report_note_v8_lease_invalid';end if;v_n:=j.failure_count+1;v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_n<4 then 'queued' else 'failed' end;update public.verified_theme_report_note_jobs_v8 set status=v_next,failure_count=v_n,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'report note failed'),3000),finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=j.id;return jsonb_build_object('status',v_next,'failure_count',v_n,'retry_scheduled',(v_next='queued'));end
$function$;

revoke all on function public.create_verified_theme_report_run_v8() from public,anon,authenticated;
revoke all on function public.claim_verified_theme_report_note_job_v8(integer) from public,anon,authenticated;
revoke all on function public.get_verified_theme_report_note_input_v8(uuid,uuid) from public,anon,authenticated;
revoke all on function public.prepare_verified_theme_report_final_v8(uuid) from public,anon,authenticated;
revoke all on function public.fail_verified_theme_report_note_job_v8(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.create_verified_theme_report_run_v8() to service_role;
grant execute on function public.claim_verified_theme_report_note_job_v8(integer) to service_role;
grant execute on function public.get_verified_theme_report_note_input_v8(uuid,uuid) to service_role;
grant execute on function public.prepare_verified_theme_report_final_v8(uuid) to service_role;
grant execute on function public.fail_verified_theme_report_note_job_v8(uuid,uuid,text,boolean) to service_role;
commit;
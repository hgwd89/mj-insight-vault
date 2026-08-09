begin;

alter table public.verified_theme_report_runs_v8 drop constraint if exists verified_theme_report_runs_v8_analysis_proof_receipt_id_key;
alter table public.verified_theme_report_runs_v8
  add column if not exists source_job_id uuid references public.chat_jobs(id) on delete restrict,
  add column if not exists user_query text,
  add column if not exists request_fingerprint text;
alter table public.verified_theme_report_runs_v8
  add constraint verified_theme_report_runs_v8_source_job_id_key unique(source_job_id),
  add constraint verified_theme_report_runs_v8_request_fingerprint_check check(request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$');

alter table public.verified_theme_reports_v8
  add column if not exists source_job_id uuid references public.chat_jobs(id) on delete restrict,
  add column if not exists user_query text,
  add column if not exists request_fingerprint text;
alter table public.verified_theme_reports_v8
  add constraint verified_theme_reports_v8_source_job_id_key unique(source_job_id),
  add constraint verified_theme_reports_v8_request_fingerprint_check check(request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$');

create or replace function public.verified_report_request_fingerprint_v15(p_source_job_id uuid)
returns text
language sql stable security definer
set search_path='pg_catalog','public','extensions'
as $function$
  select encode(extensions.digest(convert_to(jsonb_build_object('user_query',j.user_query,'request_json',j.request_json)::text,'UTF8'),'sha256'),'hex')
  from public.chat_jobs j where j.id=p_source_job_id;
$function$;

create or replace function public.create_verified_theme_report_run_v15(p_source_job_id uuid)
returns uuid
language plpgsql security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare
  v_proof uuid; v_analysis uuid; v_n integer; v_run uuid; v_fp text; v_query text; v_existing public.verified_theme_report_runs_v8%rowtype; v_report_fp text;
begin
  if (select analysis_gate from public.verified_theme_analysis_gate_v8)<>'passed' then raise exception 'verified_report_v15_analysis_proof_required'; end if;
  select user_query into v_query from public.chat_jobs where id=p_source_job_id;
  if not found or char_length(btrim(coalesce(v_query,'')))<1 then raise exception 'verified_report_v15_source_job_invalid'; end if;
  v_fp:=public.verified_report_request_fingerprint_v15(p_source_job_id);
  if coalesce(v_fp,'')!~'^[0-9a-f]{64}$' then raise exception 'verified_report_v15_request_fingerprint_invalid'; end if;
  v_proof:=public.record_verified_theme_analysis_proof_v8();
  select analysis_run_id,candidate_count into v_analysis,v_n from public.verified_theme_analysis_proof_receipts_v8 where id=v_proof;
  select * into v_existing from public.verified_theme_report_runs_v8 where source_job_id=p_source_job_id;
  if found then
    if v_existing.analysis_proof_receipt_id<>v_proof or v_existing.request_fingerprint<>v_fp or v_existing.user_query<>v_query then raise exception 'verified_report_v15_source_job_stale_recreate_job_required'; end if;
    return v_existing.id;
  end if;
  insert into public.verified_theme_report_runs_v8(analysis_proof_receipt_id,analysis_run_id,candidate_count,source_job_id,user_query,request_fingerprint)
  values(v_proof,v_analysis,v_n,p_source_job_id,v_query,v_fp) returning id into v_run;
  if v_n=0 then
    v_report_fp:=encode(extensions.digest(convert_to(v_proof::text||'|'||v_fp||'|no_defensible_theme_candidates','UTF8'),'sha256'),'hex');
    insert into public.verified_theme_reports_v8(run_id,analysis_proof_receipt_id,source_job_id,user_query,request_fingerprint,executive_summary,cross_theme_observations,major_theme_ids,methodology_note,theme_metrics_json,theme_notes_json,report_fingerprint,updated_at)
    values(v_run,v_proof,p_source_job_id,v_query,v_fp,'検証済み記事全件のレビューと全コーパス・センサスの結果、この指示に対して正式なテーマ候補として残るものはありませんでした。','[]'::jsonb,'{}'::uuid[],'記事単位の検証済みOCR、独立レビュー、全候補センサス、決定論的集計に基づく。テーマ候補がゼロの場合は生成AIによる補完を行わない。','[]'::jsonb,'[]'::jsonb,v_report_fp,now());
    update public.verified_theme_report_runs_v8 set status='completed',finished_at=now(),error_message=null,updated_at=now() where id=v_run;
    return v_run;
  end if;
  insert into public.verified_theme_report_note_jobs_v8(run_id,candidate_id)
  select v_run,c.id from public.verified_theme_candidates_v7 c where c.analysis_run_id=v_analysis;
  return v_run;
end
$function$;

create or replace function public.get_verified_theme_report_note_input_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare j public.verified_theme_report_note_jobs_v8%rowtype;rr public.verified_theme_report_runs_v8%rowtype;v_metric jsonb;v_evidence jsonb;v_generator jsonb;
begin
  select * into j from public.verified_theme_report_note_jobs_v8 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_note_v15_lease_invalid'; end if;
  select * into rr from public.verified_theme_report_runs_v8 where id=j.run_id;
  if rr.source_job_id is null or rr.request_fingerprint<>public.verified_report_request_fingerprint_v15(rr.source_job_id) then raise exception 'verified_report_note_v15_request_stale'; end if;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=rr.analysis_proof_receipt_id) then raise exception 'verified_report_note_v15_proof_stale'; end if;
  select to_jsonb(m) into v_metric from public.verified_theme_metrics_v8 m where m.candidate_id=j.candidate_id;
  if v_metric is null then raise exception 'verified_report_note_v15_metric_missing'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('article_id',e.article_id,'article_date',e.article_date,'relation',e.relation,'mapping_confidence',e.mapping_confidence,'evidence_roles',e.evidence_roles,'mapper_source_anchor',e.mapper_source_anchor,'critic_source_anchor',e.critic_source_anchor,'verified_crop_ocr_text',v.analysis_text) order by e.relation,e.article_id),'[]'::jsonb)
    into v_evidence from public.verified_theme_deterministic_evidence_v8 e join public.formal_verified_article_text_v5 v on v.article_id=e.article_id where e.candidate_id=j.candidate_id;
  if j.active_pass_kind='critic' then select result_json into v_generator from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind='generator'; if v_generator is null then raise exception 'verified_report_note_v15_critic_requires_generator'; end if; end if;
  return jsonb_build_object(
    'report_request',jsonb_build_object('source_job_id',rr.source_job_id,'user_query',rr.user_query,'request_fingerprint',rr.request_fingerprint),
    'job',jsonb_build_object('id',j.id,'run_id',j.run_id,'candidate_id',j.candidate_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token),
    'metric',v_metric,'deterministic_evidence',v_evidence,'generator_output',v_generator);
end
$function$;

create or replace function public.get_verified_theme_report_final_input_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare j public.verified_theme_report_final_jobs_v8%rowtype;r public.verified_theme_report_runs_v8%rowtype;v_fp text;v_notes jsonb;v_metrics jsonb;v_gen jsonb;
begin
  select * into j from public.verified_theme_report_final_jobs_v8 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_final_v15_lease_invalid'; end if;
  select * into r from public.verified_theme_report_runs_v8 where id=j.run_id;
  if r.source_job_id is null or r.request_fingerprint<>public.verified_report_request_fingerprint_v15(r.source_job_id) then raise exception 'verified_report_final_v15_request_stale'; end if;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=r.analysis_proof_receipt_id) then raise exception 'verified_report_final_v15_proof_stale'; end if;
  select encode(extensions.digest(convert_to(coalesce(string_agg(n.candidate_id::text||':'||n.interpretation||':'||n.trajectory_interpretation||':'||n.limitation||':'||array_to_string(n.evidence_article_ids,','),'|' order by n.candidate_id::text),''),'UTF8'),'sha256'),'hex'),
         jsonb_agg(jsonb_build_object('candidate_id',n.candidate_id,'interpretation',n.interpretation,'trajectory_interpretation',n.trajectory_interpretation,'limitation',n.limitation,'evidence_article_ids',n.evidence_article_ids) order by n.candidate_id)
    into v_fp,v_notes from public.verified_theme_report_notes_v8 n where n.run_id=r.id;
  if v_fp<>j.note_set_fingerprint or coalesce(jsonb_array_length(v_notes),0)<>r.candidate_count then raise exception 'verified_report_final_v15_note_set_stale'; end if;
  select jsonb_agg(to_jsonb(m) order by m.candidate_id) into v_metrics from public.verified_theme_metrics_v8 m;
  if coalesce(jsonb_array_length(v_metrics),0)<>r.candidate_count then raise exception 'verified_report_final_v15_metric_set_stale'; end if;
  if j.active_pass_kind='critic' then select result_json into v_gen from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='generator';if v_gen is null then raise exception 'verified_report_final_v15_critic_requires_generator';end if;end if;
  return jsonb_build_object(
    'report_request',jsonb_build_object('source_job_id',r.source_job_id,'user_query',r.user_query,'request_fingerprint',r.request_fingerprint),
    'job',jsonb_build_object('id',j.id,'run_id',j.run_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token,'note_set_fingerprint',j.note_set_fingerprint),
    'theme_metrics',v_metrics,'theme_notes',v_notes,'generator_output',v_gen);
end
$function$;

create or replace function public.finalize_verified_theme_report_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare j public.verified_theme_report_final_jobs_v8%rowtype;r public.verified_theme_report_runs_v8%rowtype;g public.verified_theme_report_final_passes_v8%rowtype;c public.verified_theme_report_final_passes_v8%rowtype;v_metrics jsonb;v_notes jsonb;v_fp text;v_report uuid;
begin
  select * into j from public.verified_theme_report_final_jobs_v8 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_final_v15_lease_invalid'; end if;
  select * into r from public.verified_theme_report_runs_v8 where id=j.run_id for update;
  if r.source_job_id is null or r.request_fingerprint<>public.verified_report_request_fingerprint_v15(r.source_job_id) then raise exception 'verified_report_final_v15_request_stale'; end if;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=r.analysis_proof_receipt_id) then raise exception 'verified_report_final_v15_proof_stale'; end if;
  select * into g from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='generator';select * into c from public.verified_theme_report_final_passes_v8 where job_id=j.id and pass_kind='critic';
  if g.job_id is null or c.job_id is null or g.model=c.model or g.provider_response_id=c.provider_response_id or g.prompt_sha256=c.prompt_sha256 then raise exception 'verified_report_final_v15_independent_passes_required'; end if;
  if not coalesce((c.result_json->>'approved')::boolean,false) or not coalesce((c.result_json->>'coverage_complete')::boolean,false) or not coalesce((c.result_json->>'metrics_consistent')::boolean,false) or not coalesce((c.result_json->>'evidence_scope_valid')::boolean,false) or coalesce((c.result_json->>'overclaim_risk')::boolean,true) then
    update public.verified_theme_report_final_jobs_v8 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(c.result_json->>'reason','final report critic did not approve'),2000),updated_at=now() where id=j.id;
    update public.verified_theme_report_runs_v8 set status='needs_review',error_message='final report critic did not approve',updated_at=now() where id=r.id;
    return jsonb_build_object('status','needs_review');
  end if;
  select jsonb_agg(to_jsonb(m) order by m.candidate_id) into v_metrics from public.verified_theme_metrics_v8 m;
  select jsonb_agg(jsonb_build_object('candidate_id',n.candidate_id,'interpretation',n.interpretation,'trajectory_interpretation',n.trajectory_interpretation,'limitation',n.limitation,'evidence_article_ids',n.evidence_article_ids) order by n.candidate_id) into v_notes from public.verified_theme_report_notes_v8 n where n.run_id=r.id;
  v_fp:=encode(extensions.digest(convert_to(r.analysis_proof_receipt_id::text||'|'||r.request_fingerprint||'|'||(g.result_json->>'executive_summary')||'|'||coalesce((g.result_json->'cross_theme_observations')::text,'[]')||'|'||coalesce((g.result_json->'major_theme_ids')::text,'[]')||'|'||coalesce(v_metrics::text,'[]')||'|'||coalesce(v_notes::text,'[]'),'UTF8'),'sha256'),'hex');
  insert into public.verified_theme_reports_v8(run_id,analysis_proof_receipt_id,source_job_id,user_query,request_fingerprint,executive_summary,cross_theme_observations,major_theme_ids,methodology_note,theme_metrics_json,theme_notes_json,report_fingerprint,updated_at)
  values(r.id,r.analysis_proof_receipt_id,r.source_job_id,r.user_query,r.request_fingerprint,g.result_json->>'executive_summary',g.result_json->'cross_theme_observations',array(select x::uuid from jsonb_array_elements_text(g.result_json->'major_theme_ids') x),'記事単位の原画像由来OCRを独立検証し、全記事レビュー、全seed候補化、全候補の全記事センサス、決定論的月次集計を経た結果のみを使用。数値指標はDB計算値であり生成AIに生成させない。',v_metrics,v_notes,v_fp,now())
  on conflict(run_id) do update set source_job_id=excluded.source_job_id,user_query=excluded.user_query,request_fingerprint=excluded.request_fingerprint,executive_summary=excluded.executive_summary,cross_theme_observations=excluded.cross_theme_observations,major_theme_ids=excluded.major_theme_ids,methodology_note=excluded.methodology_note,theme_metrics_json=excluded.theme_metrics_json,theme_notes_json=excluded.theme_notes_json,report_fingerprint=excluded.report_fingerprint,updated_at=now()
  returning id into v_report;
  update public.verified_theme_report_final_jobs_v8 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  update public.verified_theme_report_runs_v8 set status='completed',error_message=null,finished_at=now(),updated_at=now() where id=r.id;
  return jsonb_build_object('status','completed','report_id',v_report,'report_fingerprint',v_fp,'request_fingerprint',r.request_fingerprint);
end
$function$;

create or replace function public.verified_theme_report_integrity_v15(p_report_id uuid,p_source_job_id uuid)
returns boolean
language plpgsql stable security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare rp public.verified_theme_reports_v8%rowtype;rr public.verified_theme_report_runs_v8%rowtype;v_expected text;
begin
  select * into rp from public.verified_theme_reports_v8 where id=p_report_id;
  if not found or rp.source_job_id is distinct from p_source_job_id then return false; end if;
  select * into rr from public.verified_theme_report_runs_v8 where id=rp.run_id;
  if not found or rr.status<>'completed' or rr.source_job_id is distinct from p_source_job_id or rr.analysis_proof_receipt_id<>rp.analysis_proof_receipt_id or rr.request_fingerprint<>rp.request_fingerprint or rr.user_query<>rp.user_query then return false; end if;
  if rr.request_fingerprint is distinct from public.verified_report_request_fingerprint_v15(p_source_job_id) then return false; end if;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=rr.analysis_proof_receipt_id) then return false; end if;
  if not exists(select 1 from public.verified_theme_report_final_jobs_v8 j where j.run_id=rr.id and j.status='completed') and rr.candidate_count>0 then return false; end if;
  v_expected:=encode(extensions.digest(convert_to(rr.analysis_proof_receipt_id::text||'|'||rr.request_fingerprint||'|'||rp.executive_summary||'|'||coalesce(rp.cross_theme_observations::text,'[]')||'|'||to_jsonb(rp.major_theme_ids)::text||'|'||coalesce(rp.theme_metrics_json::text,'[]')||'|'||coalesce(rp.theme_notes_json::text,'[]'),'UTF8'),'sha256'),'hex');
  if rr.candidate_count=0 then v_expected:=encode(extensions.digest(convert_to(rr.analysis_proof_receipt_id::text||'|'||rr.request_fingerprint||'|no_defensible_theme_candidates','UTF8'),'sha256'),'hex'); end if;
  return rp.report_fingerprint=v_expected;
end
$function$;

create or replace function public.verified_theme_report_related_article_ids_v15(p_report_id uuid)
returns uuid[]
language sql stable security definer
set search_path='pg_catalog','public'
as $function$
  select coalesce(array_agg(distinct x order by x),'{}'::uuid[])
  from public.verified_theme_reports_v8 rp
  join public.verified_theme_report_notes_v8 n on n.run_id=rp.run_id
  cross join lateral unnest(n.evidence_article_ids) x
  where rp.id=p_report_id;
$function$;

create or replace function public.render_verified_theme_report_text_v15(p_report_id uuid)
returns text
language plpgsql stable security definer
set search_path='pg_catalog','public'
as $function$
declare rp public.verified_theme_reports_v8%rowtype;v_themes text;
begin
  select * into rp from public.verified_theme_reports_v8 where id=p_report_id;
  if not found then return null; end if;
  select string_agg(
    '## '||m.title||E'\n\n'||
    '支持記事: '||m.support_article_count::text||'件 / 反証記事: '||m.counter_article_count::text||'件 / 関連非支持: '||m.related_not_supporting_article_count::text||'件'||E'\n\n'||
    n.interpretation||E'\n\n'||n.trajectory_interpretation||E'\n\n### 制約・反証\n'||n.limitation,
    E'\n\n' order by m.support_article_count desc,m.candidate_id)
  into v_themes
  from public.verified_theme_report_notes_v8 n join public.verified_theme_metrics_v8 m on m.candidate_id=n.candidate_id
  where n.run_id=rp.run_id;
  return '# 正式・検証済みレポート'||E'\n\n' || rp.user_query || E'\n\n## 要約\n\n' || rp.executive_summary ||
         case when coalesce(v_themes,'')='' then '' else E'\n\n'||v_themes end || E'\n\n## 方法\n\n' || rp.methodology_note;
end
$function$;

create or replace function public.verified_theme_report_payload_v15(p_report_id uuid,p_source_job_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path='pg_catalog','public'
as $function$
declare rp public.verified_theme_reports_v8%rowtype;rr public.verified_theme_report_runs_v8%rowtype;v_articles integer;
begin
  if not public.verified_theme_report_integrity_v15(p_report_id,p_source_job_id) then raise exception 'verified_report_v15_integrity_required'; end if;
  select * into rp from public.verified_theme_reports_v8 where id=p_report_id;
  select * into rr from public.verified_theme_report_runs_v8 where id=rp.run_id;
  select article_count into v_articles from public.current_verified_ocr_corpus_receipt_v5;
  return jsonb_build_object(
    'formal_gate_version','verified_theme_report_v15_query_bound',
    'generation_path','verified_ocr_full_corpus_theme_report_v15',
    'verified_report_id',rp.id,'verified_report_run_id',rp.run_id,'source_job_id',p_source_job_id,
    'analysis_proof_receipt_id',rp.analysis_proof_receipt_id,'request_fingerprint',rp.request_fingerprint,'user_query',rp.user_query,
    'full_corpus_gate','passed','report_kind','formal','generation_status','completed','is_formal_report',true,'analysis_verification_status','full_corpus_verified_v15',
    'executive_summary',rp.executive_summary,'cross_theme_observations',rp.cross_theme_observations,'major_theme_ids',to_jsonb(rp.major_theme_ids),
    'methodology_note',rp.methodology_note,'theme_metrics',rp.theme_metrics_json,'theme_notes',rp.theme_notes_json,'report_fingerprint',rp.report_fingerprint,
    'source_coverage',jsonb_build_object('formal_article_count',coalesce(v_articles,0),'full_corpus_gate','passed','verification','verified_ocr_full_corpus_v15'));
end
$function$;

create or replace function public.publish_verified_theme_report_to_chat_v15(p_source_job_id uuid,p_verified_report_id uuid)
returns uuid
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare v_payload jsonb;v_text text;v_related uuid[];v_query text;v_id uuid;v_existing public.chat_reports%rowtype;
begin
  if not public.verified_theme_report_integrity_v15(p_verified_report_id,p_source_job_id) then raise exception 'verified_report_v15_integrity_required'; end if;
  select user_query into v_query from public.chat_jobs where id=p_source_job_id;
  if not found then raise exception 'verified_report_v15_source_job_missing'; end if;
  v_payload:=public.verified_theme_report_payload_v15(p_verified_report_id,p_source_job_id);
  v_text:=public.render_verified_theme_report_text_v15(p_verified_report_id);
  v_related:=public.verified_theme_report_related_article_ids_v15(p_verified_report_id);
  select * into v_existing from public.chat_reports where source_job_id=p_source_job_id;
  if found then
    if v_existing.answer_json=v_payload and v_existing.is_formal_report and v_existing.full_corpus_gate='passed' then return v_existing.id; end if;
    raise exception 'verified_report_v15_source_job_report_conflict';
  end if;
  insert into public.chat_reports(user_query,answer_text,answer_json,related_article_ids,report_kind,generation_status,is_formal_report,analysis_verification_status,full_corpus_gate,source_job_id)
  values(v_query,v_text,v_payload,v_related,'formal','completed',true,'full_corpus_verified_v15','passed',p_source_job_id)
  returning id into v_id;
  return v_id;
end
$function$;

create or replace function public.enforce_only_v6_formal_report_row()
returns trigger
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare v_job uuid;j public.formal_report_jobs_v6%rowtype;v_report uuid;v_source uuid;begin
  if coalesce(new.answer_json->>'formal_gate_version','')='verified_theme_report_v15_query_bound' then
    begin v_report:=(new.answer_json->>'verified_report_id')::uuid;v_source:=(new.answer_json->>'source_job_id')::uuid; exception when others then raise exception 'formal_v15_report_ids_invalid'; end;
    if new.source_job_id is distinct from v_source or not public.verified_theme_report_integrity_v15(v_report,v_source) then raise exception 'formal_v15_report_integrity_required'; end if;
    if new.answer_json<>public.verified_theme_report_payload_v15(v_report,v_source) then raise exception 'formal_v15_payload_must_be_database_generated'; end if;
    new.answer_text:=public.render_verified_theme_report_text_v15(v_report);
    new.related_article_ids:=public.verified_theme_report_related_article_ids_v15(v_report);
    new.report_kind:='formal';new.generation_status:='completed';new.is_formal_report:=true;new.analysis_verification_status:='full_corpus_verified_v15';new.full_corpus_gate:='passed';
  elsif coalesce(new.answer_json->>'formal_gate_version','')='formal_report_v6_claim_graph' then
    begin v_job:=(new.answer_json->>'report_job_id')::uuid; exception when others then raise exception 'formal_v6_report_job_id_invalid'; end;
    select * into j from public.formal_report_jobs_v6 where id=v_job;
    if not found or j.status not in ('completed','published') or not public.formal_report_integrity_v6(j.id) then raise exception 'formal_v6_report_integrity_required'; end if;
    if new.answer_json<>public.formal_report_payload_v6(j.id) then raise exception 'formal_v6_payload_must_be_database_generated'; end if;
    new.answer_text:=public.render_formal_report_text_v6(j.id);
    new.related_article_ids:=public.formal_report_related_article_ids_v6(j.id);
    new.report_kind:='formal';new.generation_status:='completed';new.is_formal_report:=true;new.analysis_verification_status:='full_corpus_verified_v6';new.full_corpus_gate:='passed';
  else
    new.is_formal_report:=false;
    if coalesce(new.report_kind,'')='formal' then new.report_kind:='provisional'; end if;
    new.analysis_verification_status:='provisional_unverified';new.full_corpus_gate:='failed';
  end if;
  return new;
end
$function$;

drop trigger if exists trg_0000_normalize_hierarchical_report_v1 on public.chat_reports;
create trigger trg_0000_normalize_hierarchical_report_v1 before insert or update of answer_json on public.chat_reports for each row
when (coalesce(new.answer_json->>'formal_gate_version','') not in ('formal_report_v6_claim_graph','verified_theme_report_v15_query_bound')) execute function public.normalize_hierarchical_report_before_gate_v1();
drop trigger if exists trg_000_quarantine_invalid_formal_attempt_v1 on public.chat_reports;
create trigger trg_000_quarantine_invalid_formal_attempt_v1 before insert or update of answer_json on public.chat_reports for each row
when (coalesce(new.answer_json->>'formal_gate_version','') not in ('formal_report_v6_claim_graph','verified_theme_report_v15_query_bound')) execute function public.quarantine_invalid_formal_report_attempt_v1();
drop trigger if exists trg_00_enforce_category_report_classification_v1 on public.chat_reports;
create trigger trg_00_enforce_category_report_classification_v1 before insert or update of answer_json on public.chat_reports for each row
when (coalesce(new.answer_json->>'formal_gate_version','') not in ('formal_report_v6_claim_graph','verified_theme_report_v15_query_bound')) execute function public.enforce_category_report_classification_v1();
drop trigger if exists trg_enforce_semantic_review_v2 on public.chat_reports;
create trigger trg_enforce_semantic_review_v2 before insert or update of answer_json on public.chat_reports for each row
when (coalesce(new.answer_json->>'formal_gate_version','') not in ('formal_report_v6_claim_graph','verified_theme_report_v15_query_bound')) execute function public.enforce_semantic_review_v2();
drop trigger if exists trg_sync_chat_report_metadata on public.chat_reports;
create trigger trg_sync_chat_report_metadata before insert or update of answer_json on public.chat_reports for each row
when (coalesce(new.answer_json->>'formal_gate_version','') not in ('formal_report_v6_claim_graph','verified_theme_report_v15_query_bound')) execute function public.sync_chat_report_metadata();
drop trigger if exists trg_zzzz_enforce_aaaa_formal_contract_v1 on public.chat_reports;
create trigger trg_zzzz_enforce_aaaa_formal_contract_v1 before insert or update of answer_json on public.chat_reports for each row
when (coalesce(new.answer_json->>'formal_gate_version','') not in ('formal_report_v6_claim_graph','verified_theme_report_v15_query_bound')) execute function public.enforce_aaaa_formal_contract_v1();

create index if not exists chat_reports_verified_formal_v15_idx on public.chat_reports(created_at desc) where is_formal_report=true and full_corpus_gate='passed';
create index if not exists verified_theme_report_runs_v8_source_job_idx on public.verified_theme_report_runs_v8(source_job_id);
create index if not exists verified_theme_reports_v8_source_job_idx on public.verified_theme_reports_v8(source_job_id);

revoke all on function public.verified_report_request_fingerprint_v15(uuid) from public,anon,authenticated;
grant execute on function public.verified_report_request_fingerprint_v15(uuid) to service_role;
revoke all on function public.create_verified_theme_report_run_v15(uuid) from public,anon,authenticated;
grant execute on function public.create_verified_theme_report_run_v15(uuid) to service_role;
revoke execute on function public.create_verified_theme_report_run_v8() from service_role;
revoke all on function public.verified_theme_report_integrity_v15(uuid,uuid) from public,anon,authenticated;
grant execute on function public.verified_theme_report_integrity_v15(uuid,uuid) to service_role;
revoke all on function public.verified_theme_report_payload_v15(uuid,uuid) from public,anon,authenticated;
grant execute on function public.verified_theme_report_payload_v15(uuid,uuid) to service_role;
revoke all on function public.render_verified_theme_report_text_v15(uuid) from public,anon,authenticated;
grant execute on function public.render_verified_theme_report_text_v15(uuid) to service_role;
revoke all on function public.verified_theme_report_related_article_ids_v15(uuid) from public,anon,authenticated;
grant execute on function public.verified_theme_report_related_article_ids_v15(uuid) to service_role;
revoke all on function public.publish_verified_theme_report_to_chat_v15(uuid,uuid) from public,anon,authenticated;
grant execute on function public.publish_verified_theme_report_to_chat_v15(uuid,uuid) to service_role;

commit;
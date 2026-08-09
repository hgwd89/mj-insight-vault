begin;

create or replace function public.store_verified_theme_report_note_pass_v8(
  p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb
) returns jsonb
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare j public.verified_theme_report_note_jobs_v8%rowtype;o public.verified_theme_report_note_passes_v8%rowtype;v_ids integer;v_distinct integer;
begin
  select * into j from public.verified_theme_report_note_jobs_v8 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_note_v13_lease_invalid'; end if;
  if p_pass_kind not in ('generator','critic') or j.active_pass_kind is distinct from p_pass_kind then raise exception 'verified_report_note_v13_pass_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' then raise exception 'verified_report_note_v13_receipt_or_result_invalid'; end if;
  select * into o from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind<>p_pass_kind;
  if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_report_note_v13_independent_pass_required'; end if;
  if p_pass_kind='generator' then
    if char_length(btrim(coalesce(p_result->>'interpretation','')))<8 or char_length(btrim(coalesce(p_result->>'trajectory_interpretation','')))<4 or char_length(btrim(coalesce(p_result->>'limitation','')))<4 or jsonb_typeof(p_result->'evidence_article_ids')<>'array' then raise exception 'verified_report_note_v13_generator_schema_invalid'; end if;
    if (p_result->>'interpretation') ~ '[0-9０-９]' or (p_result->>'trajectory_interpretation') ~ '[0-9０-９]' or (p_result->>'limitation') ~ '[0-9０-９]' then raise exception 'verified_report_note_v13_freeform_numbers_forbidden'; end if;
    select count(*)::integer,count(distinct x)::integer into v_ids,v_distinct from jsonb_array_elements_text(p_result->'evidence_article_ids') x;
    if v_ids<>v_distinct then raise exception 'verified_report_note_v13_duplicate_evidence_ids'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_result->'evidence_article_ids') x where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or not exists(select 1 from public.verified_theme_deterministic_evidence_v8 e where e.candidate_id=j.candidate_id and e.article_id=x::uuid)) then raise exception 'verified_report_note_v13_evidence_id_invalid'; end if;
    delete from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind='critic';
  else
    if not exists(select 1 from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind='generator') then raise exception 'verified_report_note_v13_critic_requires_generator'; end if;
    if jsonb_typeof(p_result->'approved')<>'boolean'
       or jsonb_typeof(p_result->'evidence_supported')<>'boolean'
       or jsonb_typeof(p_result->'trend_consistent')<>'boolean'
       or jsonb_typeof(p_result->'limitation_adequate')<>'boolean'
       or jsonb_typeof(p_result->'counterevidence_handled')<>'boolean'
       or jsonb_typeof(p_result->'overclaim_risk')<>'boolean'
       or char_length(btrim(coalesce(p_result->>'reason','')))<4 then raise exception 'verified_report_note_v13_critic_schema_invalid'; end if;
  end if;
  insert into public.verified_theme_report_note_passes_v8(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='critic' then return public.finalize_verified_theme_report_note_v8(j.id,j.lease_token); end if;
  update public.verified_theme_report_note_jobs_v8 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','completed_stage','generator');
end
$function$;

create or replace function public.finalize_verified_theme_report_note_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare
  j public.verified_theme_report_note_jobs_v8%rowtype;
  g public.verified_theme_report_note_passes_v8%rowtype;
  c public.verified_theme_report_note_passes_v8%rowtype;
  v_ids uuid[];
  v_support integer;
  v_counter integer;
  v_final uuid;
begin
  select * into j from public.verified_theme_report_note_jobs_v8 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_note_v13_lease_invalid'; end if;
  select * into g from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind='generator';
  select * into c from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind='critic';
  if g.job_id is null or c.job_id is null or g.model=c.model or g.provider_response_id=c.provider_response_id or g.prompt_sha256=c.prompt_sha256 then raise exception 'verified_report_note_v13_independent_passes_required'; end if;
  select support_article_count,counter_article_count into v_support,v_counter from public.verified_theme_metrics_v8 where candidate_id=j.candidate_id;
  if v_support is null then raise exception 'verified_report_note_v13_metrics_missing'; end if;
  if not coalesce((c.result_json->>'approved')::boolean,false)
     or not coalesce((c.result_json->>'evidence_supported')::boolean,false)
     or not coalesce((c.result_json->>'trend_consistent')::boolean,false)
     or not coalesce((c.result_json->>'limitation_adequate')::boolean,false)
     or (coalesce(v_counter,0)>0 and not coalesce((c.result_json->>'counterevidence_handled')::boolean,false))
     or coalesce((c.result_json->>'overclaim_risk')::boolean,true) then
    update public.verified_theme_report_note_jobs_v8 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(c.result_json->>'reason','report note critic did not approve or counterevidence was not handled'),2000),updated_at=now() where id=j.id;
    return jsonb_build_object('status','needs_review');
  end if;
  select coalesce(array_agg(x::uuid order by x::uuid::text),'{}'::uuid[]) into v_ids from jsonb_array_elements_text(g.result_json->'evidence_article_ids') x;
  if v_support>0 and not exists(select 1 from unnest(v_ids) x join public.verified_theme_deterministic_evidence_v8 e on e.candidate_id=j.candidate_id and e.article_id=x where e.relation='support') then raise exception 'verified_report_note_v13_support_evidence_required'; end if;
  if coalesce(v_counter,0)>0 and not exists(select 1 from unnest(v_ids) x join public.verified_theme_deterministic_evidence_v8 e on e.candidate_id=j.candidate_id and e.article_id=x where e.relation='counter') then raise exception 'verified_report_note_v13_counter_evidence_required'; end if;
  if exists(select 1 from unnest(v_ids) x where not exists(select 1 from public.verified_theme_deterministic_evidence_v8 e where e.candidate_id=j.candidate_id and e.article_id=x)) then raise exception 'verified_report_note_v13_evidence_id_invalid'; end if;
  insert into public.verified_theme_report_notes_v8(run_id,candidate_id,interpretation,trajectory_interpretation,limitation,evidence_article_ids,generator_model,critic_model,updated_at)
  values(j.run_id,j.candidate_id,g.result_json->>'interpretation',g.result_json->>'trajectory_interpretation',g.result_json->>'limitation',v_ids,g.model,c.model,now())
  on conflict(run_id,candidate_id) do update set interpretation=excluded.interpretation,trajectory_interpretation=excluded.trajectory_interpretation,limitation=excluded.limitation,evidence_article_ids=excluded.evidence_article_ids,generator_model=excluded.generator_model,critic_model=excluded.critic_model,updated_at=now();
  update public.verified_theme_report_note_jobs_v8 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  v_final:=public.prepare_verified_theme_report_final_v8(j.run_id);
  return jsonb_build_object('status','completed','final_job_id',v_final,'support_article_count',v_support,'counter_article_count',coalesce(v_counter,0));
end
$function$;

revoke all on function public.store_verified_theme_report_note_pass_v8(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.store_verified_theme_report_note_pass_v8(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
revoke all on function public.finalize_verified_theme_report_note_v8(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finalize_verified_theme_report_note_v8(uuid,uuid) to service_role;

commit;
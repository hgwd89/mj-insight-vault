begin;

create or replace function public.store_verified_theme_seed_chunk_pass_v7(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_theme_seed_chunk_jobs_v7%rowtype;o public.verified_theme_seed_chunk_passes_v7%rowtype;v_count integer;v_distinct integer;v_covered integer;v_all_approved boolean;v_missing integer;v_consolidation uuid;
begin
  select * into j from public.verified_theme_seed_chunk_jobs_v7 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_theme_chunk_v7_lease_invalid'; end if;
  if p_pass_kind not in ('synthesizer','critic') or j.active_pass_kind is distinct from p_pass_kind then raise exception 'verified_theme_chunk_v7_pass_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' then raise exception 'verified_theme_chunk_v7_receipt_or_result_invalid'; end if;
  select * into o from public.verified_theme_seed_chunk_passes_v7 where job_id=j.id and pass_kind<>p_pass_kind;
  if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_theme_chunk_v7_independent_pass_required'; end if;

  if p_pass_kind='synthesizer' then
    if jsonb_typeof(p_result->'proposals')<>'array' or jsonb_array_length(p_result->'proposals')=0 then raise exception 'verified_theme_chunk_v7_proposals_required'; end if;
    select count(*)::integer,count(distinct proposal_key)::integer into v_count,v_distinct
      from jsonb_to_recordset(p_result->'proposals') x(proposal_key text,title text,definition text,scope_boundary text,subject text,measurement text,support_seed_ids uuid[]);
    if v_count<>v_distinct then raise exception 'verified_theme_chunk_v7_duplicate_proposal_key'; end if;
    if exists(select 1 from jsonb_to_recordset(p_result->'proposals') x(proposal_key text,title text,definition text,scope_boundary text,subject text,measurement text,support_seed_ids uuid[])
              where char_length(btrim(coalesce(x.proposal_key,'')))<1 or char_length(btrim(coalesce(x.title,'')))<2 or char_length(btrim(coalesce(x.definition,'')))<8 or char_length(btrim(coalesce(x.scope_boundary,'')))<4
                 or x.subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear')
                 or x.measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')
                 or coalesce(cardinality(x.support_seed_ids),0)<1
                 or exists(select 1 from unnest(x.support_seed_ids) sid where not(sid=any(j.seed_ids)))) then raise exception 'verified_theme_chunk_v7_proposal_invalid'; end if;
    select count(distinct sid)::integer into v_covered from jsonb_to_recordset(p_result->'proposals') x(proposal_key text,title text,definition text,scope_boundary text,subject text,measurement text,support_seed_ids uuid[]) cross join lateral unnest(x.support_seed_ids) sid;
    if v_covered<>j.seed_count then raise exception 'verified_theme_chunk_v7_seed_coverage_incomplete'; end if;
    delete from public.verified_theme_candidate_proposals_v7 where chunk_job_id=j.id;
    delete from public.verified_theme_seed_chunk_passes_v7 where job_id=j.id and pass_kind='critic';
    insert into public.verified_theme_candidate_proposals_v7(chunk_job_id,proposal_key,title,definition,scope_boundary,subject,measurement,support_seed_ids,updated_at)
      select j.id,x.proposal_key,left(x.title,300),left(x.definition,2000),left(x.scope_boundary,1600),x.subject,x.measurement,x.support_seed_ids,now()
      from jsonb_to_recordset(p_result->'proposals') x(proposal_key text,title text,definition text,scope_boundary text,subject text,measurement text,support_seed_ids uuid[]);
  else
    if not exists(select 1 from public.verified_theme_seed_chunk_passes_v7 where job_id=j.id and pass_kind='synthesizer') then raise exception 'verified_theme_chunk_v7_critic_requires_synthesizer'; end if;
    if jsonb_typeof(p_result->'proposal_reviews')<>'array' or jsonb_typeof(p_result->'coverage_complete')<>'boolean' or jsonb_typeof(p_result->'missing_seed_ids')<>'array' then raise exception 'verified_theme_chunk_v7_critic_schema_invalid'; end if;
    select count(*)::integer,count(distinct proposal_key)::integer,bool_and(verdict='approved') into v_count,v_distinct,v_all_approved
      from jsonb_to_recordset(p_result->'proposal_reviews') x(proposal_key text,verdict text,reason text);
    if v_count<>(select count(*) from public.verified_theme_candidate_proposals_v7 where chunk_job_id=j.id) or v_count<>v_distinct then raise exception 'verified_theme_chunk_v7_critic_proposal_set_mismatch'; end if;
    if exists(select 1 from jsonb_to_recordset(p_result->'proposal_reviews') x(proposal_key text,verdict text,reason text)
              where x.verdict not in ('approved','rejected','unresolved') or char_length(btrim(coalesce(x.reason,'')))<4 or not exists(select 1 from public.verified_theme_candidate_proposals_v7 p where p.chunk_job_id=j.id and p.proposal_key=x.proposal_key)) then raise exception 'verified_theme_chunk_v7_critic_row_invalid'; end if;
    select count(*)::integer into v_missing from jsonb_array_elements_text(p_result->'missing_seed_ids');
    if not coalesce((p_result->>'coverage_complete')::boolean,false) or v_missing>0 or not coalesce(v_all_approved,false) then
      insert into public.verified_theme_seed_chunk_passes_v7(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
      values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
      on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
      update public.verified_theme_seed_chunk_jobs_v7 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='theme chunk critic rejected proposal set or seed coverage',updated_at=now() where id=j.id;
      return jsonb_build_object('status','needs_review');
    end if;
  end if;

  insert into public.verified_theme_seed_chunk_passes_v7(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='synthesizer' then
    update public.verified_theme_seed_chunk_jobs_v7 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=j.id;
    return jsonb_build_object('status','queued','completed_stage','synthesizer');
  end if;
  update public.verified_theme_seed_chunk_jobs_v7 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  v_consolidation:=public.prepare_verified_theme_consolidation_v7(j.analysis_run_id);
  return jsonb_build_object('status','completed','consolidation_job_id',v_consolidation);
end
$function$;

revoke all on function public.store_verified_theme_seed_chunk_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.store_verified_theme_seed_chunk_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
commit;
begin;

create or replace function public.finalize_article_classification_job_v6(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.article_classification_jobs_v4%rowtype;i public.formal_article_classification_input_v6%rowtype;
  a jsonb;c jsonb;ra public.article_classification_pass_runs_v4%rowtype;rc public.article_classification_pass_runs_v4%rowtype;
  v_status_a text;v_status_c text;v_primary_a text;v_primary_c text;v_conf_a numeric;v_conf_c numeric;
  v_members_a text[];v_members_c text[];v_profile_id uuid;v_reason text;v_anchor text;
begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id for update;
  if not found or j.classifier_version<>'article_category_profile_v6_verified_ocr_dual' or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'classification_v6_lease_invalid'; end if;
  select * into i from public.formal_article_classification_input_v6 where article_id=j.article_id;
  if not found or i.classification_input_sha256<>j.classification_input_sha256 or i.ocr_receipt_id is distinct from j.ocr_receipt_id or i.duplicate_audit_run_id is distinct from j.duplicate_audit_run_id then raise exception 'classification_v6_input_stale'; end if;
  select result_json into a from public.article_classification_stage_v6 where job_id=j.id and pass_kind='classifier';
  select result_json into c from public.article_classification_stage_v6 where job_id=j.id and pass_kind='critic';
  select * into ra from public.article_classification_pass_runs_v4 where job_id=j.id and pass_kind='classifier';
  select * into rc from public.article_classification_pass_runs_v4 where job_id=j.id and pass_kind='critic';
  if a is null or c is null or ra.job_id is null or rc.job_id is null then raise exception 'classification_v6_passes_incomplete'; end if;
  if ra.model=rc.model or ra.provider_response_id=rc.provider_response_id or ra.prompt_sha256=rc.prompt_sha256 then raise exception 'classification_v6_independent_passes_required'; end if;

  v_status_a:=a->>'classification_status';v_status_c:=c->>'classification_status';
  v_primary_a:=nullif(btrim(a->>'primary_category'),'');v_primary_c:=nullif(btrim(c->>'primary_category'),'');
  v_conf_a:=coalesce((a->>'confidence')::numeric,0);v_conf_c:=coalesce((c->>'confidence')::numeric,0);
  select coalesce(array_agg(category_id order by category_id),'{}'::text[]) into v_members_a from (select distinct x.category_id from jsonb_to_recordset(coalesce(a->'memberships','[]'::jsonb)) x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)) q;
  select coalesce(array_agg(category_id order by category_id),'{}'::text[]) into v_members_c from (select distinct x.category_id from jsonb_to_recordset(coalesce(c->'memberships','[]'::jsonb)) x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)) q;

  if v_status_a not in ('categorized','no_matching_category') or v_status_c not in ('categorized','no_matching_category') or v_status_a<>v_status_c or v_primary_a is distinct from v_primary_c or v_members_a<>v_members_c or least(v_conf_a,v_conf_c)<0.75 then
    update public.article_classification_jobs_v4 set status='needs_review',active_pass_kind=null,result_json=jsonb_build_object('classifier',a,'critic',c),last_error_class='classification_disagreement',error_message='verified OCR dual classifier disagreement or confidence below 0.75',lease_token=null,lease_expires_at=null,next_retry_at=null,updated_at=now() where id=j.id;
    return jsonb_build_object('status','needs_review','reason','dual_classifier_disagreement_or_low_confidence');
  end if;

  if v_status_a='no_matching_category' then
    if v_primary_a is not null or cardinality(v_members_a)<>0 then raise exception 'classification_v6_no_match_must_have_no_memberships'; end if;
  else
    if v_primary_a is null or cardinality(v_members_a)<1 or not(v_primary_a=any(v_members_a)) then raise exception 'classification_v6_primary_membership_invalid'; end if;
    if exists(select 1 from unnest(v_members_a) x left join public.analysis_categories ac on ac.id=x and ac.is_active=true where ac.id is null) then raise exception 'classification_v6_unknown_category'; end if;
    if not public.verified_article_anchor_present_v6(j.article_id,a->>'source_anchor') or not public.verified_article_anchor_present_v6(j.article_id,c->>'source_anchor') then raise exception 'classification_v6_profile_anchor_not_verified'; end if;
    if exists(select 1 from jsonb_to_recordset(a->'memberships') x(category_id text,score numeric,confidence numeric,source_anchor text,reason text) where coalesce(x.confidence,0)<0.70 or coalesce(x.score,0)<0 or coalesce(x.score,0)>1 or not public.verified_article_anchor_present_v6(j.article_id,x.source_anchor))
       or exists(select 1 from jsonb_to_recordset(c->'memberships') x(category_id text,score numeric,confidence numeric,source_anchor text,reason text) where coalesce(x.confidence,0)<0.70 or coalesce(x.score,0)<0 or coalesce(x.score,0)>1 or not public.verified_article_anchor_present_v6(j.article_id,x.source_anchor)) then raise exception 'classification_v6_membership_evidence_invalid'; end if;
  end if;

  v_reason:=coalesce(a->>'reason','');v_anchor:=nullif(a->>'source_anchor','');
  if coalesce(btrim(v_reason),'')='' then raise exception 'classification_v6_reason_required'; end if;
  insert into public.article_profiles_v4(
    article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,
    category_catalog_fingerprint,classification_input_sha256,classification_status,primary_category,consumer_scene,market_signal,product_type,consumer_need,
    confidence,reason,source_anchor,classifier_model,critic_model,classifier_version,evidence_json,classification_job_id,
    ocr_receipt_id,ocr_verification_set_fingerprint,duplicate_audit_run_id,updated_at
  ) values(
    j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,
    j.category_catalog_fingerprint,j.classification_input_sha256,v_status_a,v_primary_a,a->>'consumer_scene',a->>'market_signal',a->>'product_type',a->>'consumer_need',
    least(v_conf_a,v_conf_c),v_reason,v_anchor,ra.model,rc.model,j.classifier_version,jsonb_build_object('classifier',a,'critic',c),j.id,
    j.ocr_receipt_id,j.ocr_verification_set_fingerprint,j.duplicate_audit_run_id,now()
  )
  on conflict(article_id,freeze_receipt_id,classifier_version,classification_input_sha256,category_catalog_fingerprint)
  do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,
    classification_status=excluded.classification_status,primary_category=excluded.primary_category,consumer_scene=excluded.consumer_scene,market_signal=excluded.market_signal,product_type=excluded.product_type,consumer_need=excluded.consumer_need,
    confidence=excluded.confidence,reason=excluded.reason,source_anchor=excluded.source_anchor,classifier_model=excluded.classifier_model,critic_model=excluded.critic_model,evidence_json=excluded.evidence_json,
    classification_job_id=excluded.classification_job_id,ocr_receipt_id=excluded.ocr_receipt_id,ocr_verification_set_fingerprint=excluded.ocr_verification_set_fingerprint,duplicate_audit_run_id=excluded.duplicate_audit_run_id,updated_at=now()
  returning id into v_profile_id;

  delete from public.article_category_memberships_v4 where profile_id=v_profile_id;
  if v_status_a='categorized' then
    insert into public.article_category_memberships_v4(profile_id,article_id,category_id,score,confidence,source_anchor,reason,evidence_json)
    select v_profile_id,j.article_id,x.category_id,least(x.score,y.score),least(x.confidence,y.confidence),x.source_anchor,coalesce(x.reason,''),jsonb_build_object('classifier',to_jsonb(x),'critic',to_jsonb(y))
    from jsonb_to_recordset(a->'memberships') x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)
    join jsonb_to_recordset(c->'memberships') y(category_id text,score numeric,confidence numeric,source_anchor text,reason text) using(category_id);
  end if;

  update public.article_classification_jobs_v4 set status='completed',active_pass_kind=null,result_json=jsonb_build_object('classifier',a,'critic',c,'profile_id',v_profile_id),lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','profile_id',v_profile_id,'classification_status',v_status_a);
end
$function$;

create or replace function public.store_article_classification_pass_v6(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare j public.article_classification_jobs_v4%rowtype;v_other public.article_classification_pass_runs_v4%rowtype;
begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id for update;
  if not found or j.classifier_version<>'article_category_profile_v6_verified_ocr_dual' or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'classification_v6_lease_invalid'; end if;
  if p_pass_kind not in ('classifier','critic') or j.active_pass_kind is distinct from p_pass_kind then raise exception 'classification_v6_pass_kind_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'classification_v6_receipt_invalid'; end if;
  if jsonb_typeof(p_result)<>'object' then raise exception 'classification_v6_result_must_be_object'; end if;
  select * into v_other from public.article_classification_pass_runs_v4 where job_id=j.id and pass_kind<>p_pass_kind;
  if found and (v_other.model=p_model or v_other.provider_response_id=p_provider_response_id or v_other.prompt_sha256=p_prompt_sha256) then raise exception 'classification_v6_independent_pass_required'; end if;
  insert into public.article_classification_pass_runs_v4(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();
  insert into public.article_classification_stage_v6(job_id,pass_kind,result_json,updated_at)
  values(j.id,p_pass_kind,p_result,now())
  on conflict(job_id,pass_kind) do update set result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='critic' then return public.finalize_article_classification_job_v6(j.id,j.lease_token); end if;
  update public.article_classification_jobs_v4 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','completed_stage','classifier');
end
$function$;

create or replace view public.formal_article_profiles_v6
with (security_invoker=true)
as
select p.*
from public.article_profiles_v4 p
join public.formal_article_classification_input_v6 i on i.article_id=p.article_id
join public.article_classification_jobs_v4 j on j.id=p.classification_job_id and j.status='completed'
join public.article_classification_pass_runs_v4 ca on ca.job_id=j.id and ca.pass_kind='classifier'
join public.article_classification_pass_runs_v4 cr on cr.job_id=j.id and cr.pass_kind='critic'
where p.classifier_version='article_category_profile_v6_verified_ocr_dual'
  and ca.model<>cr.model and ca.provider_response_id<>cr.provider_response_id and ca.prompt_sha256<>cr.prompt_sha256
  and p.article_id=j.article_id and p.freeze_receipt_id=i.freeze_receipt_id and p.freeze_receipt_id=j.freeze_receipt_id
  and p.source_region_id=i.source_region_id and p.source_region_id=j.source_region_id
  and p.source_partition_job_id=i.partition_job_id and p.source_partition_job_id=j.source_partition_job_id
  and p.source_region_sha256=i.source_region_sha256 and p.source_region_sha256=j.source_region_sha256
  and p.source_ocr_sha256=i.current_source_raw_ocr_sha256 and p.source_ocr_sha256=j.source_ocr_sha256
  and p.category_catalog_fingerprint=i.category_catalog_fingerprint and p.category_catalog_fingerprint=j.category_catalog_fingerprint
  and p.classification_input_sha256=i.classification_input_sha256 and p.classification_input_sha256=j.classification_input_sha256
  and p.ocr_receipt_id=i.ocr_receipt_id and p.ocr_receipt_id=j.ocr_receipt_id
  and p.ocr_verification_set_fingerprint=i.ocr_verification_set_fingerprint and p.ocr_verification_set_fingerprint=j.ocr_verification_set_fingerprint
  and p.duplicate_audit_run_id=i.duplicate_audit_run_id and p.duplicate_audit_run_id=j.duplicate_audit_run_id;
revoke all on public.formal_article_profiles_v6 from public,anon,authenticated;
grant select on public.formal_article_profiles_v6 to service_role;

create or replace view public.article_classification_quality_gate_v6
with (security_invoker=true)
as
with expected as (select count(*)::integer n from public.formal_article_classification_input_v6),
profiles as (select count(*)::integer n,count(*) filter(where classification_status='no_matching_category')::integer no_match from public.formal_article_profiles_v6),
jobs as (
  select count(*)::integer total,count(*) filter(where status='queued')::integer queued,count(*) filter(where status='running')::integer running,
         count(*) filter(where status='needs_review')::integer needs_review,count(*) filter(where status='completed')::integer completed,count(*) filter(where status='failed')::integer failed
  from public.article_classification_jobs_v4 where classifier_version='article_category_profile_v6_verified_ocr_dual'
)
select expected.n formal_article_count,profiles.n profiled_article_count,(profiles.n-profiles.no_match)::integer categorized_article_count,profiles.no_match no_matching_category_count,
       jobs.total total_jobs,jobs.queued queued_jobs,jobs.running running_jobs,jobs.needs_review review_jobs,jobs.completed completed_jobs,jobs.failed failed_jobs,
       case when expected.n>0 and profiles.n=expected.n and jobs.total=expected.n and jobs.completed=expected.n and jobs.needs_review=0 and jobs.failed=0 then 'passed' else 'failed' end category_classification_gate,
       case when expected.n=0 then 'verified_duplicate_clearance_required' when jobs.needs_review>0 then 'classification_review_required' when jobs.failed>0 then 'classification_jobs_failed' when profiles.n<>expected.n or jobs.completed<>expected.n then 'verified_ocr_classification_incomplete' else 'passed' end gate_reason
from expected cross join profiles cross join jobs;
revoke all on public.article_classification_quality_gate_v6 from public,anon,authenticated;
grant select on public.article_classification_quality_gate_v6 to service_role;

revoke all on function public.store_article_classification_pass_v6(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_article_classification_job_v6(uuid,uuid) from public,anon,authenticated;
grant execute on function public.store_article_classification_pass_v6(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.finalize_article_classification_job_v6(uuid,uuid) to service_role;

commit;
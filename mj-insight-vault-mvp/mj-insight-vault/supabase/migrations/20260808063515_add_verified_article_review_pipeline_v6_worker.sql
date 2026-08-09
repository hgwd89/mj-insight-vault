begin;

create or replace function public.enqueue_verified_article_review_jobs_v6()
returns integer
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare v_receipt uuid;v_count integer;
begin
  if (select category_classification_gate from public.article_classification_quality_gate_v6)<>'passed' then raise exception 'verified_review_v6_classification_required'; end if;
  v_receipt:=public.record_category_classification_corpus_receipt_v7();
  with r as (select * from public.category_classification_corpus_receipts_v7 where id=v_receipt), ins as (
    insert into public.verified_article_review_jobs_v6(article_id,classification_receipt_id,verified_text_sha256,review_input_sha256)
    select v.article_id,r.id,v.analysis_text_sha256,
           encode(extensions.digest(convert_to(jsonb_build_object('article_id',v.article_id,'verified_text_sha256',v.analysis_text_sha256,'classification_receipt_id',r.id,'profile_set_fingerprint',r.profile_set_fingerprint)::text,'UTF8'),'sha256'),'hex')
    from public.formal_verified_article_text_v5 v cross join r
    on conflict(article_id,classification_receipt_id,review_version,review_input_sha256) do nothing returning 1
  ) select count(*)::integer into v_count from ins;
  return v_count;
end
$function$;

create or replace function public.claim_verified_article_review_job_v6(p_lease_seconds integer default 240)
returns setof public.verified_article_review_jobs_v6
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_receipt uuid;v_id uuid;v_status text;v_pass text;v_token uuid:=gen_random_uuid();
begin
  select id into v_receipt from public.current_category_classification_corpus_receipt_v7;
  if v_receipt is null then raise exception 'verified_review_v6_classification_receipt_required'; end if;
  update public.verified_article_review_jobs_v6 set status='failed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='review lease expired too many times',finished_at=now(),updated_at=now()
  where classification_receipt_id=v_receipt and status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now() and failure_count>=3;
  select j.id,j.status,
         case when not exists(select 1 from public.verified_article_review_passes_v6 p where p.job_id=j.id and p.pass_kind='reviewer') then 'reviewer'
              when not exists(select 1 from public.verified_article_review_passes_v6 p where p.job_id=j.id and p.pass_kind='critic') then 'critic' else null end
  into v_id,v_status,v_pass
  from public.verified_article_review_jobs_v6 j
  where j.classification_receipt_id=v_receipt and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now())) and j.failure_count<4
    and (not exists(select 1 from public.verified_article_review_passes_v6 p where p.job_id=j.id and p.pass_kind='reviewer') or not exists(select 1 from public.verified_article_review_passes_v6 p where p.job_id=j.id and p.pass_kind='critic'))
  order by j.created_at for update skip locked limit 1;
  if v_id is null or v_pass is null then return; end if;
  update public.verified_article_review_jobs_v6 set status='running',active_pass_kind=v_pass,lease_token=v_token,
    lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),failure_count=failure_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now()
  where id=v_id;
  return query select * from public.verified_article_review_jobs_v6 where id=v_id;
end
$function$;

create or replace function public.get_verified_article_review_input_v6(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_article_review_jobs_v6%rowtype;r public.category_classification_corpus_receipts_v7%rowtype;v_text text;v_sha text;v_reviewer jsonb;
begin
  select * into j from public.verified_article_review_jobs_v6 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_review_v6_lease_invalid'; end if;
  select * into r from public.current_category_classification_corpus_receipt_v7 where id=j.classification_receipt_id;
  if not found then raise exception 'verified_review_v6_receipt_stale'; end if;
  select analysis_text,analysis_text_sha256 into v_text,v_sha from public.formal_verified_article_text_v5 where article_id=j.article_id;
  if coalesce(v_text,'')='' or v_sha<>j.verified_text_sha256 then raise exception 'verified_review_v6_text_stale'; end if;
  if j.active_pass_kind='critic' then
    select result_json into v_reviewer from public.verified_article_review_passes_v6 where job_id=j.id and pass_kind='reviewer';
    if v_reviewer is null then raise exception 'verified_review_v6_critic_requires_reviewer'; end if;
  end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'article_id',j.article_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token,'review_input_sha256',j.review_input_sha256),
    'verified_crop_ocr_text',v_text,'verified_text_sha256',v_sha,'reviewer_output',v_reviewer);
end
$function$;

create or replace function public.finalize_verified_article_review_job_v6(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_article_review_jobs_v6%rowtype;rv public.verified_article_review_passes_v6%rowtype;cr public.verified_article_review_passes_v6%rowtype;a jsonb;c jsonb;v_review uuid;v_idx integer:=0;
begin
  select * into j from public.verified_article_review_jobs_v6 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_review_v6_lease_invalid'; end if;
  if not exists(select 1 from public.current_category_classification_corpus_receipt_v7 where id=j.classification_receipt_id) then raise exception 'verified_review_v6_receipt_stale'; end if;
  select * into rv from public.verified_article_review_passes_v6 where job_id=j.id and pass_kind='reviewer';
  select * into cr from public.verified_article_review_passes_v6 where job_id=j.id and pass_kind='critic';
  if rv.job_id is null or cr.job_id is null or rv.model=cr.model or rv.provider_response_id=cr.provider_response_id or rv.prompt_sha256=cr.prompt_sha256 then raise exception 'verified_review_v6_independent_passes_required'; end if;
  a:=rv.result_json;c:=cr.result_json;
  if not public.validate_verified_reviewer_json_v6(j.article_id,a) then raise exception 'verified_review_v6_reviewer_invalid'; end if;
  if (c->>'verdict')<>'approved' or coalesce((c->>'fact_supported')::boolean,false)=false or coalesce((c->>'coverage_complete')::boolean,false)=false or coalesce((c->>'no_theme_signal_valid')::boolean,false)=false or coalesce((c->>'seeds_grounded')::boolean,false)=false or coalesce((c->>'overclaim_risk')::boolean,true)=true then
    update public.verified_article_review_jobs_v6 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(c->>'reason','critic did not fully approve'),2000),updated_at=now() where id=j.id;
    return jsonb_build_object('status','needs_review');
  end if;
  insert into public.verified_article_reviews_v6(job_id,article_id,classification_receipt_id,verified_text_sha256,review_input_sha256,subject,measurement,consumer_relevance,observed_fact,limitation,no_theme_signal,no_theme_signal_reason,observed_fact_anchor,reviewer_model,critic_model,review_version,updated_at)
  values(j.id,j.article_id,j.classification_receipt_id,j.verified_text_sha256,j.review_input_sha256,a->>'subject',a->>'measurement',a->>'consumer_relevance',a->>'observed_fact',a->>'limitation',(a->>'no_theme_signal')::boolean,nullif(a->>'no_theme_signal_reason',''),a->>'observed_fact_anchor',rv.model,cr.model,j.review_version,now())
  on conflict(article_id,classification_receipt_id,review_version,review_input_sha256) do update set job_id=excluded.job_id,subject=excluded.subject,measurement=excluded.measurement,consumer_relevance=excluded.consumer_relevance,observed_fact=excluded.observed_fact,limitation=excluded.limitation,no_theme_signal=excluded.no_theme_signal,no_theme_signal_reason=excluded.no_theme_signal_reason,observed_fact_anchor=excluded.observed_fact_anchor,reviewer_model=excluded.reviewer_model,critic_model=excluded.critic_model,updated_at=now()
  returning id into v_review;
  delete from public.verified_article_review_anchors_v6 where review_id=v_review;
  insert into public.verified_article_review_anchors_v6(review_id,anchor_slot,anchor_text,anchor_position)
  values(v_review,'observed_fact',a->>'observed_fact_anchor',public.verified_review_anchor_position_v6(j.article_id,a->>'observed_fact_anchor'));
  insert into public.verified_article_review_anchors_v6(review_id,anchor_slot,anchor_text,anchor_position)
  select v_review,'coverage_'||lpad(ord::text,2,'0'),x.anchor_text,public.verified_review_anchor_position_v6(j.article_id,x.anchor_text)
  from jsonb_to_recordset(a->'coverage_anchors') with ordinality x(anchor_text text,ord bigint);
  delete from public.verified_article_theme_seeds_v6 where review_id=v_review;
  insert into public.verified_article_theme_seeds_v6(review_id,article_id,seed_label,seed_statement,subject,measurement,confidence,source_anchor)
  select v_review,j.article_id,s.seed_label,s.seed_statement,s.subject,s.measurement,s.confidence,s.source_anchor
  from jsonb_to_recordset(coalesce(a->'theme_seeds','[]'::jsonb)) s(seed_label text,seed_statement text,subject text,measurement text,confidence numeric,source_anchor text);
  update public.verified_article_review_jobs_v6 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','review_id',v_review);
end
$function$;

create or replace function public.store_verified_article_review_pass_v6(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_article_review_jobs_v6%rowtype;o public.verified_article_review_passes_v6%rowtype;
begin
  select * into j from public.verified_article_review_jobs_v6 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_review_v6_lease_invalid'; end if;
  if j.active_pass_kind is distinct from p_pass_kind or p_pass_kind not in ('reviewer','critic') then raise exception 'verified_review_v6_pass_kind_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' then raise exception 'verified_review_v6_receipt_or_result_invalid'; end if;
  select * into o from public.verified_article_review_passes_v6 where job_id=j.id and pass_kind<>p_pass_kind;
  if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_review_v6_independent_pass_required'; end if;
  if p_pass_kind='reviewer' then
    if not public.validate_verified_reviewer_json_v6(j.article_id,p_result) then raise exception 'verified_review_v6_reviewer_invalid'; end if;
    delete from public.verified_article_review_passes_v6 where job_id=j.id and pass_kind='critic';
  else
    if not exists(select 1 from public.verified_article_review_passes_v6 where job_id=j.id and pass_kind='reviewer') then raise exception 'verified_review_v6_critic_requires_reviewer'; end if;
    if (p_result->>'verdict') not in ('approved','rejected','unresolved') or jsonb_typeof(p_result->'fact_supported')<>'boolean' or jsonb_typeof(p_result->'coverage_complete')<>'boolean' or jsonb_typeof(p_result->'no_theme_signal_valid')<>'boolean' or jsonb_typeof(p_result->'seeds_grounded')<>'boolean' or jsonb_typeof(p_result->'overclaim_risk')<>'boolean' or char_length(btrim(coalesce(p_result->>'reason','')))<4 then raise exception 'verified_review_v6_critic_invalid'; end if;
  end if;
  insert into public.verified_article_review_passes_v6(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='critic' then return public.finalize_verified_article_review_job_v6(j.id,j.lease_token); end if;
  update public.verified_article_review_jobs_v6 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','queued','completed_stage','reviewer');
end
$function$;

create or replace function public.fail_verified_article_review_job_v6(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.verified_article_review_jobs_v6%rowtype;v_n integer;v_next text;
begin
 select * into j from public.verified_article_review_jobs_v6 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'verified_review_v6_lease_invalid'; end if;
 v_n:=j.failure_count+1;v_next:=case when not coalesce(p_retryable,true) then 'needs_review' when v_n<4 then 'queued' else 'failed' end;
 update public.verified_article_review_jobs_v6 set status=v_next,failure_count=v_n,active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,'review worker failed'),3000),finished_at=case when v_next='failed' then now() else null end,updated_at=now() where id=j.id;
 return jsonb_build_object('status',v_next,'failure_count',v_n,'retry_scheduled',(v_next='queued'));
end
$function$;

create or replace view public.verified_article_review_gate_v6
with (security_invoker=true)
as
with r as (select id,article_count from public.current_category_classification_corpus_receipt_v7),j as (
 select count(*)::integer total,count(*) filter(where status='queued')::integer queued,count(*) filter(where status='running')::integer running,count(*) filter(where status='needs_review')::integer needs_review,count(*) filter(where status='completed')::integer completed,count(*) filter(where status='failed')::integer failed
 from public.verified_article_review_jobs_v6 j join r on r.id=j.classification_receipt_id
),v as (select count(*)::integer reviewed from public.verified_article_reviews_v6 x join r on r.id=x.classification_receipt_id)
select coalesce(r.article_count,0)::integer expected_articles,coalesce(j.total,0)::integer jobs,coalesce(j.queued,0)::integer queued,coalesce(j.running,0)::integer running,coalesce(j.needs_review,0)::integer needs_review,coalesce(j.completed,0)::integer completed,coalesce(j.failed,0)::integer failed,coalesce(v.reviewed,0)::integer reviewed,
 case when coalesce(r.article_count,0)>0 and j.total=r.article_count and j.completed=r.article_count and v.reviewed=r.article_count and j.needs_review=0 and j.failed=0 then 'passed' else 'failed' end review_gate,
 case when r.id is null then 'classification_receipt_required' when j.needs_review>0 then 'article_review_needs_review' when j.failed>0 then 'article_review_failed' when j.completed<>r.article_count or v.reviewed<>r.article_count then 'article_review_incomplete' else 'passed' end gate_reason
from (select 1) q left join r on true left join j on true left join v on true;
revoke all on public.verified_article_review_gate_v6 from public,anon,authenticated;
grant select on public.verified_article_review_gate_v6 to service_role;

revoke all on function public.enqueue_verified_article_review_jobs_v6() from public,anon,authenticated;
revoke all on function public.claim_verified_article_review_job_v6(integer) from public,anon,authenticated;
revoke all on function public.get_verified_article_review_input_v6(uuid,uuid) from public,anon,authenticated;
revoke all on function public.store_verified_article_review_pass_v6(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_verified_article_review_job_v6(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_verified_article_review_job_v6(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.enqueue_verified_article_review_jobs_v6() to service_role;
grant execute on function public.claim_verified_article_review_job_v6(integer) to service_role;
grant execute on function public.get_verified_article_review_input_v6(uuid,uuid) to service_role;
grant execute on function public.store_verified_article_review_pass_v6(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.finalize_verified_article_review_job_v6(uuid,uuid) to service_role;
grant execute on function public.fail_verified_article_review_job_v6(uuid,uuid,text,boolean) to service_role;

commit;
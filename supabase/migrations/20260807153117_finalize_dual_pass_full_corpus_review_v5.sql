create or replace function public.store_full_corpus_review_pass_v5(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb)
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
    delete from public.full_corpus_review_pass_runs_v5 where job_id=j.id and pass_kind='critic';
    delete from public.full_corpus_reviewer_rows_v5 where job_id=j.id;
    insert into public.full_corpus_reviewer_rows_v5(job_id,article_id,reviewer_json,updated_at)
    select j.id,x.article_id,x.result,now() from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb);
  else
    if (select count(*) from public.full_corpus_reviewer_rows_v5 where job_id=j.id)<>j.article_count then raise exception 'review_v5_critic_requires_reviewer_pass'; end if;
    if exists(
      select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb)
      where jsonb_typeof(x.result)<>'object'
         or (x.result->>'verdict') not in ('approved','rejected','unresolved')
         or jsonb_typeof(x.result->'fact_supported')<>'boolean'
         or jsonb_typeof(x.result->'coverage_complete')<>'boolean'
         or jsonb_typeof(x.result->'no_theme_signal_valid')<>'boolean'
         or jsonb_typeof(x.result->'seeds_grounded')<>'boolean'
         or jsonb_typeof(x.result->'overclaim_risk')<>'boolean'
         or char_length(btrim(coalesce(x.result->>'reason','')))<4
         or ((x.result->>'verdict')='approved' and not ((x.result->>'fact_supported')::boolean and (x.result->>'coverage_complete')::boolean and (x.result->>'no_theme_signal_valid')::boolean and (x.result->>'seeds_grounded')::boolean and not (x.result->>'overclaim_risk')::boolean))
    ) then raise exception 'review_v5_critic_row_invalid'; end if;
    delete from public.full_corpus_review_critic_rows_v5 where job_id=j.id;
    insert into public.full_corpus_review_critic_rows_v5(job_id,article_id,verdict,fact_supported,coverage_complete,no_theme_signal_valid,seeds_grounded,overclaim_risk,reason,updated_at)
    select j.id,x.article_id,x.result->>'verdict',(x.result->>'fact_supported')::boolean,(x.result->>'coverage_complete')::boolean,(x.result->>'no_theme_signal_valid')::boolean,(x.result->>'seeds_grounded')::boolean,(x.result->>'overclaim_risk')::boolean,left(x.result->>'reason',1200),now()
    from jsonb_to_recordset(p_rows) x(article_id uuid,result jsonb);
  end if;

  insert into public.full_corpus_review_pass_runs_v5(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,updated_at)
  values(j.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();
  return jsonb_build_object('status','stored','pass_kind',p_pass_kind,'row_count',v_count);
end $$;

create function public.finalize_full_corpus_review_job_v5(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  j public.full_corpus_review_jobs_v5%rowtype;rv public.full_corpus_review_pass_runs_v5%rowtype;cr public.full_corpus_review_pass_runs_v5%rowtype;p record;v_approved integer;v_review_count integer;v_review_ids integer;v_completed integer;v_review integer;v_failed integer;
begin
  select * into j from public.full_corpus_review_jobs_v5 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'review_v5_job_lease_invalid'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'review_v5_freeze_stale'; end if;
  select * into p from public.review_batch_article_set_proof_v5(j.batch_id);
  if p.article_count<>j.article_count or p.article_set_fingerprint<>j.batch_article_set_fingerprint or p.batch_input_fingerprint<>j.batch_input_fingerprint then raise exception 'review_v5_batch_input_stale'; end if;
  select * into rv from public.full_corpus_review_pass_runs_v5 where job_id=j.id and pass_kind='reviewer';select * into cr from public.full_corpus_review_pass_runs_v5 where job_id=j.id and pass_kind='critic';
  if rv.job_id is null or cr.job_id is null or rv.model=cr.model or rv.provider_response_id=cr.provider_response_id or rv.prompt_sha256=cr.prompt_sha256 then raise exception 'review_v5_independent_pass_receipts_required'; end if;
  if (select count(*) from public.full_corpus_reviewer_rows_v5 where job_id=j.id)<>j.article_count or (select count(*) from public.full_corpus_review_critic_rows_v5 where job_id=j.id)<>j.article_count then raise exception 'review_v5_stage_row_count_mismatch'; end if;
  select count(*)::integer into v_approved from public.full_corpus_review_critic_rows_v5 where job_id=j.id and verdict='approved' and fact_supported and coverage_complete and no_theme_signal_valid and seeds_grounded and not overclaim_risk;
  if v_approved<>j.article_count then
    update public.full_corpus_review_jobs_v5 set status='needs_review',last_error_class='critic_not_fully_approved',error_message=format('approved=%s expected=%s',v_approved,j.article_count),lease_token=null,lease_expires_at=null,next_retry_at=null,updated_at=now() where id=j.id;
    update public.full_corpus_scan_batches set status='needs_review',error_message=format('v5 critic approved %s/%s',v_approved,j.article_count),updated_at=now() where id=j.batch_id;
    select count(*) filter(where status='completed')::integer,count(*) filter(where status='needs_review')::integer,count(*) filter(where status='failed')::integer into v_completed,v_review,v_failed from public.full_corpus_review_jobs_v5 where run_id=j.run_id;
    update public.full_corpus_scan_runs set completed_batches=v_completed,needs_review_batches=v_review,failed_batches=v_failed,updated_at=now() where id=j.run_id;
    return jsonb_build_object('status','needs_review','approved_count',v_approved,'expected_count',j.article_count);
  end if;

  if exists(select 1 from public.full_corpus_reviewer_rows_v5 rr where rr.job_id=j.id and not public.validate_reviewer_json_v5(rr.article_id,rr.reviewer_json)) then raise exception 'review_v5_reviewer_stage_stale'; end if;

  insert into public.full_corpus_article_reviews_v4(
    run_id,batch_id,batch_index,article_id,review_version,review_model,source_clean_body_sha256,source_region_id,source_region_sha256,source_image_raw_ocr_sha256,
    subject,measurement,observed_fact,limitation,no_theme_signal,no_theme_signal_reason,observed_fact_anchor
  )
  select j.run_id,j.batch_id,j.batch_index,rr.article_id,'article_review_v5_dual_source_block',rv.model,
         g.analysis_body_sha256,g.source_region_id,g.source_region_sha256,g.current_source_raw_ocr_sha256,
         rr.reviewer_json->>'subject',rr.reviewer_json->>'measurement',rr.reviewer_json->>'observed_fact',rr.reviewer_json->>'limitation',
         (rr.reviewer_json->>'no_theme_signal')::boolean,nullif(rr.reviewer_json->>'no_theme_signal_reason',''),rr.reviewer_json->>'observed_fact_anchor'
  from public.full_corpus_reviewer_rows_v5 rr join public.formal_source_grounded_articles_v4 g on g.article_id=rr.article_id
  where rr.job_id=j.id;

  get diagnostics v_review_count=row_count;
  if v_review_count<>j.article_count then raise exception 'review_v5_final_review_insert_count_mismatch'; end if;

  insert into public.full_corpus_article_review_anchors_v4(review_id,source_kind,anchor_slot,anchor_text,source_block_index)
  select r.id,'source_region',a.anchor_slot,a.anchor_text,a.block_index
  from public.full_corpus_article_reviews_v4 r
  join public.full_corpus_reviewer_rows_v5 rr on rr.article_id=r.article_id and rr.job_id=j.id
  cross join lateral jsonb_to_recordset(rr.reviewer_json->'coverage_anchors') a(anchor_slot text,block_index integer,anchor_text text)
  where r.run_id=j.run_id and r.batch_id=j.batch_id;

  insert into public.full_corpus_theme_seeds_v4(run_id,review_id,article_id,seed_version,seed_label,seed_statement,subject,measurement,source_clean_body_sha256,source_region_sha256,source_anchor,confidence)
  select j.run_id,r.id,r.article_id,'theme_seed_v5_source_block',s.seed_label,s.seed_statement,s.subject,s.measurement,r.source_clean_body_sha256,r.source_region_sha256,s.source_anchor,s.confidence
  from public.full_corpus_article_reviews_v4 r
  join public.full_corpus_reviewer_rows_v5 rr on rr.article_id=r.article_id and rr.job_id=j.id
  cross join lateral jsonb_to_recordset(coalesce(rr.reviewer_json->'theme_seeds','[]'::jsonb)) s(seed_label text,seed_statement text,subject text,measurement text,confidence numeric,source_anchor text)
  where r.run_id=j.run_id and r.batch_id=j.batch_id;

  if exists(select 1 from public.full_corpus_article_reviews_v4 r where r.run_id=j.run_id and r.batch_id=j.batch_id and not public.article_review_anchor_integrity_v4(r.id)) then raise exception 'review_v5_final_anchor_integrity_failed'; end if;
  if exists(
    select 1 from public.full_corpus_article_reviews_v4 r
    where r.run_id=j.run_id and r.batch_id=j.batch_id
      and ((r.no_theme_signal and exists(select 1 from public.full_corpus_theme_seeds_v4 s where s.review_id=r.id)) or (not r.no_theme_signal and not exists(select 1 from public.full_corpus_theme_seeds_v4 s where s.review_id=r.id)))
  ) then raise exception 'review_v5_final_seed_integrity_failed'; end if;

  update public.full_corpus_review_jobs_v5 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  update public.full_corpus_scan_batches set status='completed',model=rv.model,prompt_version='full_corpus_batch_v5_dual_source_block_review',summary_json=jsonb_build_object('proof_version','review_v5_dual_source_block','reviewer_model',rv.model,'critic_model',cr.model,'reviewer_response_id',rv.provider_response_id,'critic_response_id',cr.provider_response_id,'article_count',j.article_count),evidence_article_ids='{}'::text[],error_message=null,updated_at=now() where id=j.batch_id;
  select count(*) filter(where status='completed')::integer,count(*) filter(where status='needs_review')::integer,count(*) filter(where status='failed')::integer into v_completed,v_review,v_failed from public.full_corpus_review_jobs_v5 where run_id=j.run_id;
  select count(*)::integer into v_review_ids from public.full_corpus_article_reviews_v4 where run_id=j.run_id;
  update public.full_corpus_scan_runs set completed_batches=v_completed,needs_review_batches=v_review,failed_batches=v_failed,analyzed_article_count=v_review_ids,updated_at=now() where id=j.run_id;
  return jsonb_build_object('status','completed','review_count',v_review_count,'run_review_count',v_review_ids);
end $$;

create function public.fail_full_corpus_review_job_v5(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.full_corpus_review_jobs_v5%rowtype;v_retry boolean;v_delay integer;begin
  select * into j from public.full_corpus_review_jobs_v5 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'review_v5_job_lease_invalid'; end if;
  v_retry:=coalesce(p_retryable,true) and j.attempt_count<4;v_delay:=least(900,45*(2^greatest(0,j.attempt_count-1))::integer);
  update public.full_corpus_review_jobs_v5 set status=case when v_retry then 'queued' else 'failed' end,last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),error_message=left(coalesce(p_error_message,'review worker failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,finished_at=case when v_retry then null else now() end,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
  update public.full_corpus_scan_batches set status=case when v_retry then 'queued' else 'failed' end,error_message=left(coalesce(p_error_message,'review worker failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,updated_at=now() where id=j.batch_id;
  return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',j.attempt_count);
end $$;

create function public.requeue_full_corpus_review_job_v5(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.full_corpus_review_jobs_v5%rowtype;begin
  select * into j from public.full_corpus_review_jobs_v5 where id=p_job_id for update;if not found or j.status not in ('needs_review','failed') then raise exception 'review_v5_job_not_reviewable'; end if;
  delete from public.full_corpus_review_critic_rows_v5 where job_id=j.id;delete from public.full_corpus_reviewer_rows_v5 where job_id=j.id;delete from public.full_corpus_review_pass_runs_v5 where job_id=j.id;
  update public.full_corpus_review_jobs_v5 set status='queued',attempt_count=0,next_retry_at=null,last_error_class=null,error_message=null,finished_at=null,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
  update public.full_corpus_scan_batches set status='queued',error_message=null,next_retry_at=null,updated_at=now() where id=j.batch_id;
  return jsonb_build_object('status','queued','job_id',j.id);
end $$;

create function public.finalize_full_corpus_scan_run_v5(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.full_corpus_scan_runs%rowtype;v_total integer;v_completed integer;v_reviews integer;v_ground record;begin
  select * into r from public.full_corpus_scan_runs where id=p_run_id for update;if not found then raise exception 'scan_v5_run_missing'; end if;
  if r.analysis_contract_version<>'strict_report_v5_dual_source_review_census' or coalesce(r.coverage_json->>'prompt_version','')<>'full_corpus_batch_v5_dual_source_block_review' then raise exception 'scan_v5_contract_mismatch'; end if;
  select count(*)::integer,count(*) filter(where status='completed')::integer into v_total,v_completed from public.full_corpus_review_jobs_v5 where run_id=r.id;
  if v_total<>r.total_batches or v_completed<>v_total then raise exception 'scan_v5_review_jobs_incomplete'; end if;
  select * into v_ground from public.formal_source_grounded_scope_proof_v4('all','');
  if v_ground.article_count<>r.active_article_count or v_ground.source_grounded_fingerprint<>r.source_grounded_fingerprint then raise exception 'scan_v5_source_grounded_input_stale'; end if;
  select count(*)::integer into v_reviews from public.full_corpus_article_reviews_v4 where run_id=r.id and review_version='article_review_v5_dual_source_block';
  if v_reviews<>r.active_article_count then raise exception 'scan_v5_review_count_mismatch'; end if;
  update public.full_corpus_scan_runs set status='completed',completed_batches=v_total,failed_batches=0,needs_review_batches=0,analyzed_article_count=v_reviews,finished_at=now(),updated_at=now(),coverage_json=coverage_json||jsonb_build_object('finalized_by','finalize_full_corpus_scan_run_v5','final_review_count',v_reviews,'server_normalized_read_ids_used',false) where id=r.id;
  return jsonb_build_object('status','completed','run_id',r.id,'article_count',v_reviews,'batch_count',v_total);
end $$;

create function public.full_corpus_run_integrity_v5(p_run_id uuid)
returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
with r as (select * from public.full_corpus_scan_runs where id=p_run_id),g as (select * from public.formal_source_grounded_scope_proof_v4('all','')),jobs as (select * from public.full_corpus_review_jobs_v5 where run_id=p_run_id),reviews as (select * from public.full_corpus_article_reviews_v4 where run_id=p_run_id),seeds as (select * from public.full_corpus_theme_seeds_v4 where run_id=p_run_id),expected as (select article_id from public.formal_source_grounded_articles_v4),pass_check as (
  select j.id,
         count(p.*)::integer pass_count,
         max(p.model) filter(where p.pass_kind='reviewer') reviewer_model,
         max(p.model) filter(where p.pass_kind='critic') critic_model,
         max(p.provider_response_id) filter(where p.pass_kind='reviewer') reviewer_response,
         max(p.provider_response_id) filter(where p.pass_kind='critic') critic_response,
         max(p.prompt_sha256) filter(where p.pass_kind='reviewer') reviewer_prompt,
         max(p.prompt_sha256) filter(where p.pass_kind='critic') critic_prompt
  from jobs j left join public.full_corpus_review_pass_runs_v5 p on p.job_id=j.id group by j.id
),critic as (
  select j.id job_id,count(c.*)::integer n,count(*) filter(where c.verdict='approved' and c.fact_supported and c.coverage_complete and c.no_theme_signal_valid and c.seeds_grounded and not c.overclaim_risk)::integer approved
  from jobs j left join public.full_corpus_review_critic_rows_v5 c on c.job_id=j.id group by j.id
),review_check as (
  select rv.id,
         public.article_review_anchor_integrity_v4(rv.id) anchors_ok,
         exists(select 1 from public.unique_source_block_for_anchor_v4(rv.article_id,rv.source_region_id,rv.observed_fact_anchor) b where b.block_index=rv.observed_fact_block_index and b.source_block_sha256=rv.observed_fact_block_sha256) fact_anchor_ok,
         ((rv.no_theme_signal and not exists(select 1 from seeds s where s.review_id=rv.id)) or (not rv.no_theme_signal and exists(select 1 from seeds s where s.review_id=rv.id))) seed_cardinality_ok
  from reviews rv
),seed_check as (
  select s.id,exists(select 1 from public.unique_source_block_for_anchor_v4(s.article_id,g.source_region_id,s.source_anchor) b where b.block_index=s.source_block_index and b.source_block_sha256=s.source_block_sha256) anchor_ok
  from seeds s join public.formal_source_grounded_articles_v4 g on g.article_id=s.article_id
)
select exists(
  select 1 from r cross join g
  where r.status='completed'
    and r.scope_type='all' and coalesce(r.scope_query,'')=''
    and r.analysis_contract_version='strict_report_v5_dual_source_review_census'
    and coalesce(r.coverage_json->>'prompt_version','')='full_corpus_batch_v5_dual_source_block_review'
    and coalesce((r.coverage_json->>'server_normalized_read_ids_used')::boolean,false)=false
    and r.source_grounded_fingerprint=g.source_grounded_fingerprint
    and r.active_article_count=g.article_count and r.ocr_ready_article_count=g.article_count and r.analyzed_article_count=g.article_count
    and r.total_batches=(select count(*) from jobs) and r.completed_batches=r.total_batches and r.failed_batches=0 and coalesce(r.needs_review_batches,0)=0
    and not exists(select 1 from jobs j where j.status<>'completed' or j.article_count<>(select count(*) from public.full_corpus_reviewer_rows_v5 rr where rr.job_id=j.id) or j.article_count<>(select count(*) from public.full_corpus_review_critic_rows_v5 c where c.job_id=j.id))
    and not exists(select 1 from pass_check p where p.pass_count<>2 or p.reviewer_model=p.critic_model or p.reviewer_response=p.critic_response or p.reviewer_prompt=p.critic_prompt)
    and not exists(select 1 from critic c join jobs j on j.id=c.job_id where c.n<>j.article_count or c.approved<>j.article_count)
    and (select count(*) from reviews where review_version='article_review_v5_dual_source_block')=g.article_count
    and (select count(distinct article_id) from reviews where review_version='article_review_v5_dual_source_block')=g.article_count
    and not exists(select 1 from expected e left join reviews rv on rv.article_id=e.article_id and rv.review_version='article_review_v5_dual_source_block' where rv.article_id is null)
    and not exists(select 1 from reviews rv left join expected e on e.article_id=rv.article_id where rv.review_version='article_review_v5_dual_source_block' and e.article_id is null)
    and not exists(select 1 from review_check where not anchors_ok or not fact_anchor_ok or not seed_cardinality_ok)
    and not exists(select 1 from seed_check where not anchor_ok)
);
$$;

revoke execute on function public.finalize_full_corpus_review_job_v5(uuid,uuid) from public,anon,authenticated;revoke execute on function public.fail_full_corpus_review_job_v5(uuid,uuid,text,boolean,text) from public,anon,authenticated;revoke execute on function public.requeue_full_corpus_review_job_v5(uuid) from public,anon,authenticated;revoke execute on function public.finalize_full_corpus_scan_run_v5(uuid) from public,anon,authenticated;revoke execute on function public.full_corpus_run_integrity_v5(uuid) from public,anon,authenticated;
grant execute on function public.finalize_full_corpus_review_job_v5(uuid,uuid) to service_role;grant execute on function public.fail_full_corpus_review_job_v5(uuid,uuid,text,boolean,text) to service_role;grant execute on function public.requeue_full_corpus_review_job_v5(uuid) to service_role;grant execute on function public.finalize_full_corpus_scan_run_v5(uuid) to service_role;grant execute on function public.full_corpus_run_integrity_v5(uuid) to service_role;
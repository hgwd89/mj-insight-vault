begin;

-- No strict census data has executed yet; harden the existing v7 worker contract in-place
-- so every article explicitly returns one decision for every candidate.

create or replace function public.enqueue_verified_theme_census_v7(p_article_batch_size integer default 10)
returns integer
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare
  a public.verified_theme_analysis_runs_v7%rowtype;
  r public.verified_article_review_corpus_receipts_v7%rowtype;
  v_requested integer:=greatest(1,least(12,coalesce(p_article_batch_size,10)));
  v_candidates integer;
  v_size integer;
  v_count integer;
begin
  if (select candidate_gate from public.verified_theme_candidate_gate_v7)<>'passed' then raise exception 'verified_census_v8_candidate_gate_required'; end if;
  select ar.* into a from public.verified_theme_analysis_runs_v7 ar join public.verified_theme_candidate_gate_v7 g on g.analysis_run_id=ar.id and g.candidate_gate='passed';
  if a.id is null then raise exception 'verified_census_v8_analysis_missing'; end if;
  select * into r from public.current_verified_article_review_corpus_receipt_v7 where id=a.review_receipt_id;
  if r.id is null then raise exception 'verified_census_v8_review_receipt_stale'; end if;
  select count(*)::integer into v_candidates from public.verified_theme_candidates_v7 where analysis_run_id=a.id;
  -- Target at most roughly 120 article×candidate decisions in one model call.
  v_size:=case when v_candidates=0 then v_requested else greatest(1,least(v_requested,floor(120.0/v_candidates)::integer)) end;
  if not exists(select 1 from public.verified_theme_census_batches_v7 where analysis_run_id=a.id) then
    with src as (
      select v.article_id,v.analysis_text_sha256,row_number() over(order by v.article_id) rn
      from public.formal_verified_article_text_v5 v
      join public.verified_article_reviews_v6 ar on ar.article_id=v.article_id and ar.classification_receipt_id=r.classification_receipt_id
    ),grp as (
      select ((rn-1)/v_size+1)::integer batch_index,array_agg(article_id order by article_id) article_ids,count(*)::integer article_count,
             encode(extensions.digest(convert_to(string_agg(article_id::text||':'||analysis_text_sha256,'|' order by article_id)||'|'||a.candidate_set_fingerprint,'UTF8'),'sha256'),'hex') fp
      from src group by ((rn-1)/v_size+1)::integer
    )
    insert into public.verified_theme_census_batches_v7(analysis_run_id,batch_index,article_ids,article_count,candidate_set_fingerprint,article_batch_fingerprint,status,finished_at)
    select a.id,batch_index,article_ids,article_count,a.candidate_set_fingerprint,fp,case when v_candidates=0 then 'completed' else 'queued' end,case when v_candidates=0 then now() else null end from grp order by batch_index;
  end if;
  if v_candidates=0 then
    insert into public.verified_theme_census_article_outcomes_v7(analysis_run_id,batch_id,article_id,candidate_set_fingerprint,matched_candidate_ids,updated_at)
    select a.id,b.id,u.article_id,a.candidate_set_fingerprint,'{}'::uuid[],now() from public.verified_theme_census_batches_v7 b cross join lateral unnest(b.article_ids) u(article_id) where b.analysis_run_id=a.id
    on conflict(analysis_run_id,article_id) do update set batch_id=excluded.batch_id,candidate_set_fingerprint=excluded.candidate_set_fingerprint,matched_candidate_ids='{}'::uuid[],updated_at=now();
  end if;
  update public.verified_theme_analysis_runs_v7 set status='census',updated_at=now() where id=a.id and status='candidates_ready';
  select count(*)::integer into v_count from public.verified_theme_census_batches_v7 where analysis_run_id=a.id;
  return v_count;
end
$function$;

create or replace function public.store_verified_theme_census_pass_v7(p_batch_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare
  b public.verified_theme_census_batches_v7%rowtype;
  o public.verified_theme_census_passes_v7%rowtype;
  v_count integer;
  v_distinct integer;
  v_candidate_count integer;
  v_expected_cells integer;
  v_cells integer;
  v_unique_cells integer;
  v_diff integer;
begin
  select * into b from public.verified_theme_census_batches_v7 where id=p_batch_id for update;
  if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token or b.lease_expires_at<now() then raise exception 'verified_census_v8_lease_invalid'; end if;
  if p_pass_kind not in ('mapper','critic') or b.active_pass_kind is distinct from p_pass_kind then raise exception 'verified_census_v8_pass_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_result->'articles')<>'array' then raise exception 'verified_census_v8_receipt_or_result_invalid'; end if;
  select * into o from public.verified_theme_census_passes_v7 where batch_id=b.id and pass_kind<>p_pass_kind;
  if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_census_v8_independent_pass_required'; end if;

  select count(*)::integer into v_candidate_count from public.verified_theme_candidates_v7 where analysis_run_id=b.analysis_run_id;
  if v_candidate_count<=0 then raise exception 'verified_census_v8_candidates_missing'; end if;
  v_expected_cells:=b.article_count*v_candidate_count;

  select count(*)::integer,count(distinct article_id)::integer into v_count,v_distinct
  from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb);
  if v_count<>b.article_count or v_distinct<>b.article_count then raise exception 'verified_census_v8_article_row_count_mismatch'; end if;
  if exists(select 1 from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb) where not(x.article_id=any(b.article_ids)) or jsonb_typeof(x.decisions)<>'array') then raise exception 'verified_census_v8_article_row_invalid'; end if;

  select count(*)::integer,count(distinct (x.article_id,m.candidate_id))::integer into v_cells,v_unique_cells
  from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
  cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text);
  if v_cells<>v_expected_cells or v_unique_cells<>v_expected_cells then raise exception 'verified_census_v8_complete_matrix_required'; end if;

  if exists(
    select 1
    from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
    where not exists(select 1 from public.verified_theme_candidates_v7 c where c.analysis_run_id=b.analysis_run_id and c.id=m.candidate_id)
       or m.relation not in ('support','none')
       or coalesce(m.confidence,0)<0.70 or coalesce(m.confidence,0)>1
       or char_length(btrim(coalesce(m.reason,'')))<4
       or (m.relation='support' and (coalesce(m.confidence,0)<0.80 or char_length(btrim(coalesce(m.source_anchor,'')))<6 or public.verified_review_anchor_position_v6(x.article_id,m.source_anchor) is null))
       or (m.relation='none' and coalesce(btrim(m.source_anchor),'')<>'')
  ) then raise exception 'verified_census_v8_cell_invalid'; end if;

  -- Each article must enumerate the exact full candidate set, not merely the right cell count.
  if exists(
    select 1 from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
    where exists(
      (select c.id from public.verified_theme_candidates_v7 c where c.analysis_run_id=b.analysis_run_id
       except select m.candidate_id from jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text))
      union all
      (select m.candidate_id from jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
       except select c.id from public.verified_theme_candidates_v7 c where c.analysis_run_id=b.analysis_run_id)
    )
  ) then raise exception 'verified_census_v8_candidate_set_mismatch'; end if;

  insert into public.verified_theme_census_passes_v7(batch_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
  values(b.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
  on conflict(batch_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='mapper' then
    delete from public.verified_theme_census_passes_v7 where batch_id=b.id and pass_kind='critic';
    update public.verified_theme_census_batches_v7 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=b.id;
    return jsonb_build_object('status','queued','completed_stage','mapper','matrix_cells',v_cells);
  end if;

  with mp as (
    select x.article_id,m.candidate_id,m.relation
    from public.verified_theme_census_passes_v7 p
    cross join lateral jsonb_to_recordset(p.result_json->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
    where p.batch_id=b.id and p.pass_kind='mapper'
  ), cp as (
    select x.article_id,m.candidate_id,m.relation
    from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
  ), d as (
    (select * from mp except select * from cp) union all (select * from cp except select * from mp)
  ) select count(*)::integer into v_diff from d;
  if v_diff>0 then
    update public.verified_theme_census_batches_v7 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='census mapper/critic complete matrices disagree',updated_at=now() where id=b.id;
    return jsonb_build_object('status','needs_review','disagreement_cells',v_diff);
  end if;

  delete from public.verified_theme_census_relations_v7 where batch_id=b.id;
  delete from public.verified_theme_census_article_outcomes_v7 where batch_id=b.id;
  insert into public.verified_theme_census_article_outcomes_v7(analysis_run_id,batch_id,article_id,candidate_set_fingerprint,matched_candidate_ids,updated_at)
  select b.analysis_run_id,b.id,x.article_id,b.candidate_set_fingerprint,
         coalesce((select array_agg(m.candidate_id order by m.candidate_id::text) from jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text) where m.relation='support'),'{}'::uuid[]),now()
  from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb);

  with mpass as (
    select x.article_id,m.candidate_id,m.confidence,m.source_anchor,m.reason
    from public.verified_theme_census_passes_v7 p
    cross join lateral jsonb_to_recordset(p.result_json->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
    where p.batch_id=b.id and p.pass_kind='mapper' and m.relation='support'
  ), cpass as (
    select x.article_id,m.candidate_id,m.confidence,m.source_anchor,m.reason
    from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
    where m.relation='support'
  )
  insert into public.verified_theme_census_relations_v7(analysis_run_id,batch_id,article_id,candidate_id,mapping_confidence,mapper_source_anchor,critic_source_anchor,mapper_reason,critic_reason,updated_at)
  select b.analysis_run_id,b.id,m.article_id,m.candidate_id,least(m.confidence,c.confidence),m.source_anchor,c.source_anchor,left(m.reason,1200),left(c.reason,1200),now()
  from mpass m join cpass c using(article_id,candidate_id);

  update public.verified_theme_census_batches_v7 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=b.id;
  return jsonb_build_object('status','completed','article_count',b.article_count,'candidate_count',v_candidate_count,'matrix_cells',v_cells,'relation_count',(select count(*) from public.verified_theme_census_relations_v7 where batch_id=b.id));
end
$function$;

commit;
begin;

alter table public.verified_theme_census_relations_v7
  add column if not exists relation text not null default 'support';

do $do$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.verified_theme_census_relations_v7'::regclass
      and conname='verified_theme_census_relations_v7_relation_check'
  ) then
    alter table public.verified_theme_census_relations_v7
      add constraint verified_theme_census_relations_v7_relation_check
      check (relation in ('support','counter','related_not_supporting'));
  end if;
end $do$;

create or replace function public.store_verified_theme_census_pass_v7(
  p_batch_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb
) returns jsonb
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare
  b public.verified_theme_census_batches_v7%rowtype;
  o public.verified_theme_census_passes_v7%rowtype;
  v_count integer; v_distinct integer; v_candidate_count integer; v_expected_cells integer;
  v_cells integer; v_unique_cells integer; v_diff integer;
begin
  select * into b from public.verified_theme_census_batches_v7 where id=p_batch_id for update;
  if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token or b.lease_expires_at<now() then raise exception 'verified_census_v12_lease_invalid'; end if;
  if p_pass_kind not in ('mapper','critic') or b.active_pass_kind is distinct from p_pass_kind then raise exception 'verified_census_v12_pass_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_result->'articles')<>'array' then raise exception 'verified_census_v12_receipt_or_result_invalid'; end if;
  select * into o from public.verified_theme_census_passes_v7 where batch_id=b.id and pass_kind<>p_pass_kind;
  if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_census_v12_independent_pass_required'; end if;

  select count(*)::integer into v_candidate_count from public.verified_theme_candidates_v7 where analysis_run_id=b.analysis_run_id;
  if v_candidate_count<=0 then raise exception 'verified_census_v12_candidates_missing'; end if;
  v_expected_cells:=b.article_count*v_candidate_count;

  select count(*)::integer,count(distinct article_id)::integer into v_count,v_distinct
  from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb);
  if v_count<>b.article_count or v_distinct<>b.article_count then raise exception 'verified_census_v12_article_row_count_mismatch'; end if;
  if exists(select 1 from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb) where not(x.article_id=any(b.article_ids)) or jsonb_typeof(x.decisions)<>'array') then raise exception 'verified_census_v12_article_row_invalid'; end if;

  select count(*)::integer,count(distinct (x.article_id,m.candidate_id))::integer into v_cells,v_unique_cells
  from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
  cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text);
  if v_cells<>v_expected_cells or v_unique_cells<>v_expected_cells then raise exception 'verified_census_v12_complete_matrix_required'; end if;

  if exists(
    select 1
    from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
    where not exists(select 1 from public.verified_theme_candidates_v7 c where c.analysis_run_id=b.analysis_run_id and c.id=m.candidate_id)
       or m.relation not in ('support','counter','related_not_supporting','none')
       or coalesce(m.confidence,0)<0.70 or coalesce(m.confidence,0)>1
       or char_length(btrim(coalesce(m.reason,'')))<4
       or (m.relation in ('support','counter') and (coalesce(m.confidence,0)<0.80 or char_length(btrim(coalesce(m.source_anchor,'')))<6 or public.verified_review_anchor_position_v6(x.article_id,m.source_anchor) is null))
       or (m.relation='related_not_supporting' and (coalesce(m.confidence,0)<0.75 or char_length(btrim(coalesce(m.source_anchor,'')))<6 or public.verified_review_anchor_position_v6(x.article_id,m.source_anchor) is null))
       or (m.relation='none' and coalesce(btrim(m.source_anchor),'')<>'')
  ) then raise exception 'verified_census_v12_cell_invalid'; end if;

  if exists(
    select 1 from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
    where exists(
      (select c.id from public.verified_theme_candidates_v7 c where c.analysis_run_id=b.analysis_run_id
       except select m.candidate_id from jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text))
      union all
      (select m.candidate_id from jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
       except select c.id from public.verified_theme_candidates_v7 c where c.analysis_run_id=b.analysis_run_id)
    )
  ) then raise exception 'verified_census_v12_candidate_set_mismatch'; end if;

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
    select x.article_id,m.candidate_id,m.relation,m.confidence,m.source_anchor,m.reason
    from public.verified_theme_census_passes_v7 p
    cross join lateral jsonb_to_recordset(p.result_json->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
    where p.batch_id=b.id and p.pass_kind='mapper' and m.relation<>'none'
  ), cpass as (
    select x.article_id,m.candidate_id,m.relation,m.confidence,m.source_anchor,m.reason
    from jsonb_to_recordset(p_result->'articles') x(article_id uuid,decisions jsonb)
    cross join lateral jsonb_to_recordset(x.decisions) m(candidate_id uuid,relation text,confidence numeric,source_anchor text,reason text)
    where m.relation<>'none'
  )
  insert into public.verified_theme_census_relations_v7(analysis_run_id,batch_id,article_id,candidate_id,relation,mapping_confidence,mapper_source_anchor,critic_source_anchor,mapper_reason,critic_reason,updated_at)
  select b.analysis_run_id,b.id,m.article_id,m.candidate_id,m.relation,least(m.confidence,c.confidence),m.source_anchor,c.source_anchor,left(m.reason,1200),left(c.reason,1200),now()
  from mpass m join cpass c using(article_id,candidate_id,relation);

  update public.verified_theme_census_batches_v7 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=b.id;
  return jsonb_build_object('status','completed','article_count',b.article_count,'candidate_count',v_candidate_count,'matrix_cells',v_cells,'relation_count',(select count(*) from public.verified_theme_census_relations_v7 where batch_id=b.id));
end
$function$;

create or replace view public.verified_theme_monthly_metrics_v8
with (security_invoker=true)
as
with receipt as (select * from public.current_verified_theme_census_receipt_v8),
months as (
  select substring(v.article_date,'^[0-9]{4}-[0-9]{2}') month_key,count(*)::integer corpus_articles
  from public.formal_verified_article_text_v5 v cross join receipt r
  where v.article_date ~ '^[0-9]{4}-[0-9]{2}' group by substring(v.article_date,'^[0-9]{4}-[0-9]{2}')
), support as (
  select x.candidate_id,substring(v.article_date,'^[0-9]{4}-[0-9]{2}') month_key,count(distinct x.article_id)::integer support_articles,avg(x.mapping_confidence) avg_confidence
  from public.verified_theme_census_relations_v7 x join receipt r on r.analysis_run_id=x.analysis_run_id join public.formal_verified_article_text_v5 v on v.article_id=x.article_id
  where x.relation='support' and v.article_date ~ '^[0-9]{4}-[0-9]{2}' group by x.candidate_id,substring(v.article_date,'^[0-9]{4}-[0-9]{2}')
), grid as (
  select c.id candidate_id,m.month_key,m.corpus_articles,coalesce(s.support_articles,0) support_articles,coalesce(s.avg_confidence,0::numeric) avg_confidence
  from public.verified_theme_candidates_v7 c join receipt r on r.analysis_run_id=c.analysis_run_id cross join months m left join support s on s.candidate_id=c.id and s.month_key=m.month_key
)
select candidate_id,month_key,corpus_articles,support_articles,case when corpus_articles>0 then support_articles::numeric/corpus_articles else 0::numeric end penetration_rate,avg_confidence,dense_rank() over(order by month_key)::integer month_ordinal from grid;

create or replace view public.verified_theme_metrics_v8
with (security_invoker=true)
as
with receipt as (select * from public.current_verified_theme_census_receipt_v8),
base as (
  select c.id candidate_id,c.theme_key,c.title,c.definition,c.inclusion_rule,c.exclusion_rule,c.subject,c.measurement,
         count(distinct r.article_id) filter(where r.relation='support')::integer support_article_count,
         coalesce(avg(r.mapping_confidence) filter(where r.relation='support'),0::numeric) avg_mapping_confidence,
         count(distinct r.article_id) filter(where r.relation='counter')::integer counter_article_count,
         count(distinct r.article_id) filter(where r.relation='related_not_supporting')::integer related_not_supporting_article_count
  from public.verified_theme_candidates_v7 c join receipt x on x.analysis_run_id=c.analysis_run_id
  left join public.verified_theme_census_relations_v7 r on r.analysis_run_id=c.analysis_run_id and r.candidate_id=c.id
  group by c.id,c.theme_key,c.title,c.definition,c.inclusion_rule,c.exclusion_rule,c.subject,c.measurement
), monthly as (
  select candidate_id,count(*) filter(where support_articles>0)::integer active_month_count,min(month_key) filter(where support_articles>0) first_active_month,max(month_key) filter(where support_articles>0) last_active_month,max(penetration_rate) peak_monthly_penetration,regr_slope(penetration_rate::double precision,month_ordinal::double precision)::numeric penetration_trend_slope
  from public.verified_theme_monthly_metrics_v8 group by candidate_id
)
select b.candidate_id,b.theme_key,b.title,b.definition,b.inclusion_rule,b.exclusion_rule,b.subject,b.measurement,b.support_article_count,b.avg_mapping_confidence,x.article_count corpus_article_count,
       case when x.article_count>0 then b.support_article_count::numeric/x.article_count else 0::numeric end support_ratio,
       coalesce(m.active_month_count,0) active_month_count,m.first_active_month,m.last_active_month,coalesce(m.peak_monthly_penetration,0::numeric) peak_monthly_penetration,coalesce(m.penetration_trend_slope,0::numeric) penetration_trend_slope,
       b.counter_article_count,b.related_not_supporting_article_count,
       case when x.article_count>0 then b.counter_article_count::numeric/x.article_count else 0::numeric end counter_ratio
from base b cross join receipt x left join monthly m on m.candidate_id=b.candidate_id;

create or replace view public.verified_theme_deterministic_evidence_v8
with (security_invoker=true)
as
with receipt as (select * from public.current_verified_theme_census_receipt_v8),
src as (
  select r.candidate_id,r.article_id,r.relation,r.mapping_confidence,r.mapper_source_anchor,r.critic_source_anchor,v.article_date,v.analysis_text_sha256,
         row_number() over(partition by r.candidate_id,r.relation order by r.mapping_confidence desc,v.article_date,r.article_id) strongest_rank,
         row_number() over(partition by r.candidate_id,r.relation order by v.article_date,r.mapping_confidence desc,r.article_id) earliest_rank,
         row_number() over(partition by r.candidate_id,r.relation order by v.article_date desc nulls last,r.mapping_confidence desc,r.article_id) latest_rank
  from public.verified_theme_census_relations_v7 r join receipt x on x.analysis_run_id=r.analysis_run_id join public.formal_verified_article_text_v5 v on v.article_id=r.article_id
  where r.relation in ('support','counter')
), tagged as (
  select src.*,array_remove(array[
    case when strongest_rank=1 then relation||'_strongest' end,
    case when earliest_rank=1 then relation||'_earliest' end,
    case when latest_rank=1 then relation||'_latest' end
  ],null::text) evidence_roles
  from src where strongest_rank=1 or earliest_rank=1 or latest_rank=1
)
select candidate_id,article_id,article_date,mapping_confidence,mapper_source_anchor,critic_source_anchor,analysis_text_sha256,evidence_roles,relation from tagged;

create or replace function public.record_verified_theme_analysis_proof_v8()
returns uuid language plpgsql security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare v_census uuid;v_run uuid;v_candidates integer;v_metrics text;v_evidence text;v_id uuid;
begin
  if (select census_gate from public.verified_theme_census_gate_v7)<>'passed' then raise exception 'verified_theme_proof_v12_census_required'; end if;
  v_census:=public.record_verified_theme_census_receipt_v8();
  select analysis_run_id,candidate_count into v_run,v_candidates from public.verified_theme_census_receipts_v8 where id=v_census;
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    m.candidate_id::text||':'||m.support_article_count::text||':'||m.avg_mapping_confidence::text||':'||m.support_ratio::text||':'||m.active_month_count::text||':'||coalesce(m.first_active_month,'')||':'||coalesce(m.last_active_month,'')||':'||m.peak_monthly_penetration::text||':'||m.penetration_trend_slope::text||':'||m.counter_article_count::text||':'||m.related_not_supporting_article_count::text||':'||m.counter_ratio::text
  ,'|' order by m.candidate_id::text),''),'UTF8'),'sha256'),'hex') into v_metrics from public.verified_theme_metrics_v8 m;
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    e.candidate_id::text||':'||e.article_id::text||':'||e.relation||':'||coalesce(e.article_date,'')||':'||e.mapping_confidence::text||':'||e.mapper_source_anchor||':'||e.critic_source_anchor||':'||array_to_string(e.evidence_roles,',')
  ,'|' order by e.candidate_id::text,e.relation,e.article_id::text),''),'UTF8'),'sha256'),'hex') into v_evidence from public.verified_theme_deterministic_evidence_v8 e;
  insert into public.verified_theme_analysis_proof_receipts_v8(analysis_run_id,census_receipt_id,candidate_count,metrics_fingerprint,evidence_fingerprint)
  values(v_run,v_census,v_candidates,v_metrics,v_evidence)
  on conflict(analysis_run_id) do update set census_receipt_id=excluded.census_receipt_id,candidate_count=excluded.candidate_count,metrics_fingerprint=excluded.metrics_fingerprint,evidence_fingerprint=excluded.evidence_fingerprint,created_at=now()
  returning id into v_id;
  update public.verified_theme_analysis_runs_v7 set status='ranked',error_message=null,updated_at=now() where id=v_run;
  return v_id;
end
$function$;

create or replace function public.get_verified_theme_report_note_input_v8(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare j public.verified_theme_report_note_jobs_v8%rowtype;rr public.verified_theme_report_runs_v8%rowtype;v_metric jsonb;v_evidence jsonb;v_generator jsonb;
begin
  select * into j from public.verified_theme_report_note_jobs_v8 where id=p_job_id;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'verified_report_note_v12_lease_invalid'; end if;
  select * into rr from public.verified_theme_report_runs_v8 where id=j.run_id;
  if not exists(select 1 from public.current_verified_theme_analysis_proof_v8 p where p.id=rr.analysis_proof_receipt_id) then raise exception 'verified_report_note_v12_proof_stale'; end if;
  select to_jsonb(m) into v_metric from public.verified_theme_metrics_v8 m where m.candidate_id=j.candidate_id;
  if v_metric is null then raise exception 'verified_report_note_v12_metric_missing'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('article_id',e.article_id,'article_date',e.article_date,'relation',e.relation,'mapping_confidence',e.mapping_confidence,'evidence_roles',e.evidence_roles,'mapper_source_anchor',e.mapper_source_anchor,'critic_source_anchor',e.critic_source_anchor,'verified_crop_ocr_text',v.analysis_text) order by e.relation,e.article_id),'[]'::jsonb)
    into v_evidence from public.verified_theme_deterministic_evidence_v8 e join public.formal_verified_article_text_v5 v on v.article_id=e.article_id where e.candidate_id=j.candidate_id;
  if j.active_pass_kind='critic' then select result_json into v_generator from public.verified_theme_report_note_passes_v8 where job_id=j.id and pass_kind='generator'; if v_generator is null then raise exception 'verified_report_note_v12_critic_requires_generator'; end if; end if;
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'run_id',j.run_id,'candidate_id',j.candidate_id,'pass_kind',j.active_pass_kind,'lease_token',j.lease_token),'metric',v_metric,'deterministic_evidence',v_evidence,'generator_output',v_generator);
end
$function$;

revoke all on function public.store_verified_theme_census_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.store_verified_theme_census_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
revoke all on function public.record_verified_theme_analysis_proof_v8() from public,anon,authenticated;
grant execute on function public.record_verified_theme_analysis_proof_v8() to service_role;
revoke all on function public.get_verified_theme_report_note_input_v8(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_verified_theme_report_note_input_v8(uuid,uuid) to service_role;

commit;
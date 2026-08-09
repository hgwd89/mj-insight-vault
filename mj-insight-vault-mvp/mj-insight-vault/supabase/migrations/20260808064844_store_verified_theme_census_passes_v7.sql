begin;

create or replace function public.store_verified_theme_census_pass_v7(p_batch_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_result jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare b public.verified_theme_census_batches_v7%rowtype;o public.verified_theme_census_passes_v7%rowtype;v_count integer;v_distinct integer;v_diff integer;
begin
  select * into b from public.verified_theme_census_batches_v7 where id=p_batch_id for update;
  if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token or b.lease_expires_at<now() then raise exception 'verified_census_v7_lease_invalid'; end if;
  if p_pass_kind not in ('mapper','critic') or b.active_pass_kind is distinct from p_pass_kind then raise exception 'verified_census_v7_pass_invalid'; end if;
  if coalesce(btrim(p_model),'')='' or coalesce(btrim(p_provider_response_id),'')='' or p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_result->'articles')<>'array' then raise exception 'verified_census_v7_receipt_or_result_invalid'; end if;
  select * into o from public.verified_theme_census_passes_v7 where batch_id=b.id and pass_kind<>p_pass_kind;
  if found and (o.model=p_model or o.provider_response_id=p_provider_response_id or o.prompt_sha256=p_prompt_sha256) then raise exception 'verified_census_v7_independent_pass_required'; end if;
  select count(*)::integer,count(distinct article_id)::integer into v_count,v_distinct from jsonb_to_recordset(p_result->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb);
  if v_count<>b.article_count or v_distinct<>b.article_count then raise exception 'verified_census_v7_article_row_count_mismatch'; end if;
  if exists(select 1 from jsonb_to_recordset(p_result->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb) where not(x.article_id=any(b.article_ids)) or not coalesce(x.evaluation_complete,false) or jsonb_typeof(x.matches)<>'array') then raise exception 'verified_census_v7_article_row_invalid'; end if;
  if exists(
    select 1 from jsonb_to_recordset(p_result->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb)
    cross join lateral jsonb_to_recordset(x.matches) m(candidate_id uuid,confidence numeric,source_anchor text,reason text)
    where not exists(select 1 from public.verified_theme_candidates_v7 c where c.analysis_run_id=b.analysis_run_id and c.id=m.candidate_id)
       or coalesce(m.confidence,0)<0.80 or coalesce(m.confidence,0)>1 or char_length(btrim(coalesce(m.source_anchor,'')))<6 or public.verified_review_anchor_position_v6(x.article_id,m.source_anchor) is null or char_length(btrim(coalesce(m.reason,'')))<4
  ) then raise exception 'verified_census_v7_match_invalid'; end if;
  if exists(
    select 1 from (
      select x.article_id,m.candidate_id,count(*) n
      from jsonb_to_recordset(p_result->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb)
      cross join lateral jsonb_to_recordset(x.matches) m(candidate_id uuid,confidence numeric,source_anchor text,reason text)
      group by x.article_id,m.candidate_id having count(*)>1
    ) d
  ) then raise exception 'verified_census_v7_duplicate_match'; end if;

  insert into public.verified_theme_census_passes_v7(batch_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,result_json,updated_at)
  values(b.id,p_pass_kind,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,p_result,now())
  on conflict(batch_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,result_json=excluded.result_json,updated_at=now();
  if p_pass_kind='mapper' then
    delete from public.verified_theme_census_passes_v7 where batch_id=b.id and pass_kind='critic';
    update public.verified_theme_census_batches_v7 set status='queued',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=b.id;
    return jsonb_build_object('status','queued','completed_stage','mapper');
  end if;

  with mp as (
    select x.article_id,m.candidate_id from public.verified_theme_census_passes_v7 p
    cross join lateral jsonb_to_recordset(p.result_json->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb)
    cross join lateral jsonb_to_recordset(x.matches) m(candidate_id uuid,confidence numeric,source_anchor text,reason text)
    where p.batch_id=b.id and p.pass_kind='mapper'
  ), cp as (
    select x.article_id,m.candidate_id from jsonb_to_recordset(p_result->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb)
    cross join lateral jsonb_to_recordset(x.matches) m(candidate_id uuid,confidence numeric,source_anchor text,reason text)
  ), d as (
    (select * from mp except select * from cp) union all (select * from cp except select * from mp)
  ) select count(*)::integer into v_diff from d;
  if v_diff>0 then
    update public.verified_theme_census_batches_v7 set status='needs_review',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message='census mapper/critic theme match sets disagree',updated_at=now() where id=b.id;
    return jsonb_build_object('status','needs_review','disagreement_count',v_diff);
  end if;

  delete from public.verified_theme_census_relations_v7 where batch_id=b.id;
  delete from public.verified_theme_census_article_outcomes_v7 where batch_id=b.id;
  insert into public.verified_theme_census_article_outcomes_v7(analysis_run_id,batch_id,article_id,candidate_set_fingerprint,matched_candidate_ids,updated_at)
  select b.analysis_run_id,b.id,x.article_id,b.candidate_set_fingerprint,
         coalesce((select array_agg(m.candidate_id order by m.candidate_id::text) from jsonb_to_recordset(x.matches) m(candidate_id uuid,confidence numeric,source_anchor text,reason text)),'{}'::uuid[]),now()
  from jsonb_to_recordset(p_result->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb);

  with mpass as (
    select x.article_id,m.candidate_id,m.confidence,m.source_anchor,m.reason from public.verified_theme_census_passes_v7 p
    cross join lateral jsonb_to_recordset(p.result_json->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb)
    cross join lateral jsonb_to_recordset(x.matches) m(candidate_id uuid,confidence numeric,source_anchor text,reason text)
    where p.batch_id=b.id and p.pass_kind='mapper'
  ), cpass as (
    select x.article_id,m.candidate_id,m.confidence,m.source_anchor,m.reason from jsonb_to_recordset(p_result->'articles') x(article_id uuid,evaluation_complete boolean,matches jsonb)
    cross join lateral jsonb_to_recordset(x.matches) m(candidate_id uuid,confidence numeric,source_anchor text,reason text)
  )
  insert into public.verified_theme_census_relations_v7(analysis_run_id,batch_id,article_id,candidate_id,mapping_confidence,mapper_source_anchor,critic_source_anchor,mapper_reason,critic_reason,updated_at)
  select b.analysis_run_id,b.id,m.article_id,m.candidate_id,least(m.confidence,c.confidence),m.source_anchor,c.source_anchor,left(m.reason,1200),left(c.reason,1200),now()
  from mpass m join cpass c using(article_id,candidate_id);

  update public.verified_theme_census_batches_v7 set status='completed',active_pass_kind=null,lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=b.id;
  return jsonb_build_object('status','completed','article_count',b.article_count,'relation_count',(select count(*) from public.verified_theme_census_relations_v7 where batch_id=b.id));
end
$function$;

create view public.verified_theme_census_gate_v7
with (security_invoker=true)
as
with g as (select * from public.verified_theme_candidate_gate_v7 where candidate_gate='passed'),rr as (select * from public.current_verified_article_review_corpus_receipt_v7),b as (
 select count(*)::integer batches,count(*) filter(where x.status='completed')::integer completed,count(*) filter(where x.status='needs_review')::integer needs_review,count(*) filter(where x.status='failed')::integer failed
 from public.verified_theme_census_batches_v7 x join g on g.analysis_run_id=x.analysis_run_id
),o as (
 select count(*)::integer articles from public.verified_theme_census_article_outcomes_v7 x join g on g.analysis_run_id=x.analysis_run_id
),rel as (
 select count(*)::integer relations,count(distinct candidate_id)::integer represented_candidates from public.verified_theme_census_relations_v7 x join g on g.analysis_run_id=x.analysis_run_id
)
select g.analysis_run_id,coalesce(rr.article_count,0)::integer expected_articles,g.candidate_count,coalesce(b.batches,0)::integer batches,coalesce(b.completed,0)::integer completed_batches,coalesce(b.needs_review,0)::integer review_batches,coalesce(b.failed,0)::integer failed_batches,coalesce(o.articles,0)::integer censused_articles,coalesce(rel.relations,0)::integer relations,coalesce(rel.represented_candidates,0)::integer represented_candidates,
 case when g.analysis_run_id is not null and rr.article_count>0 and b.batches>0 and b.completed=b.batches and b.needs_review=0 and b.failed=0 and o.articles=rr.article_count then 'passed' else 'failed' end census_gate,
 case when g.analysis_run_id is null then 'theme_candidates_required' when b.needs_review>0 then 'theme_census_review_required' when b.failed>0 then 'theme_census_failed' when b.completed<>b.batches or o.articles<>rr.article_count then 'theme_census_incomplete' else 'passed' end gate_reason
from (select 1) q left join g on true left join rr on true left join b on true left join o on true left join rel on true;
revoke all on public.verified_theme_census_gate_v7 from public,anon,authenticated;
grant select on public.verified_theme_census_gate_v7 to service_role;

revoke all on function public.store_verified_theme_census_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.store_verified_theme_census_pass_v7(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
commit;
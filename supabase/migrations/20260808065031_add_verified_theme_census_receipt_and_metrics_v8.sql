begin;

create table public.verified_theme_census_receipts_v8(
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  review_receipt_id uuid not null references public.verified_article_review_corpus_receipts_v7(id) on delete cascade,
  candidate_set_fingerprint text not null check(candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),
  article_count integer not null check(article_count>0),candidate_count integer not null check(candidate_count>=0),relation_count integer not null check(relation_count>=0),
  census_fingerprint text not null check(census_fingerprint ~ '^[0-9a-f]{64}$'),created_at timestamptz not null default now()
);
alter table public.verified_theme_census_receipts_v8 enable row level security;
revoke all on public.verified_theme_census_receipts_v8 from public,anon,authenticated,service_role;
grant select on public.verified_theme_census_receipts_v8 to service_role;

create or replace function public.record_verified_theme_census_receipt_v8()
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare g record;a public.verified_theme_analysis_runs_v7%rowtype;r public.verified_article_review_corpus_receipts_v7%rowtype;v_rel integer;v_fp text;v_id uuid;
begin
  select * into g from public.verified_theme_census_gate_v7;
  if g.census_gate<>'passed' then raise exception 'verified_census_receipt_v8_gate_required'; end if;
  select * into a from public.verified_theme_analysis_runs_v7 where id=g.analysis_run_id;
  select * into r from public.current_verified_article_review_corpus_receipt_v7 where id=a.review_receipt_id;
  if r.id is null then raise exception 'verified_census_receipt_v8_review_receipt_stale'; end if;
  select count(*)::integer into v_rel from public.verified_theme_census_relations_v7 where analysis_run_id=a.id;
  select encode(extensions.digest(convert_to(
    coalesce((select string_agg(o.article_id::text||':'||array_to_string(o.matched_candidate_ids,','),'|' order by o.article_id::text) from public.verified_theme_census_article_outcomes_v7 o where o.analysis_run_id=a.id),'')
    ||'###'||coalesce((select string_agg(x.article_id::text||':'||x.candidate_id::text||':'||x.mapping_confidence::text||':'||x.mapper_source_anchor||':'||x.critic_source_anchor,'|' order by x.article_id::text,x.candidate_id::text) from public.verified_theme_census_relations_v7 x where x.analysis_run_id=a.id),'')
  ,'UTF8'),'sha256'),'hex') into v_fp;
  insert into public.verified_theme_census_receipts_v8(analysis_run_id,review_receipt_id,candidate_set_fingerprint,article_count,candidate_count,relation_count,census_fingerprint)
  values(a.id,r.id,a.candidate_set_fingerprint,r.article_count,g.candidate_count,v_rel,v_fp)
  on conflict(analysis_run_id) do update set review_receipt_id=excluded.review_receipt_id,candidate_set_fingerprint=excluded.candidate_set_fingerprint,article_count=excluded.article_count,candidate_count=excluded.candidate_count,relation_count=excluded.relation_count,census_fingerprint=excluded.census_fingerprint,created_at=now()
  returning id into v_id;
  return v_id;
end
$function$;
revoke all on function public.record_verified_theme_census_receipt_v8() from public,anon,authenticated;
grant execute on function public.record_verified_theme_census_receipt_v8() to service_role;

create view public.current_verified_theme_census_receipt_v8
with (security_invoker=true)
as
select r.* from public.verified_theme_census_receipts_v8 r join public.verified_theme_census_gate_v7 g on g.census_gate='passed' and g.analysis_run_id=r.analysis_run_id and g.expected_articles=r.article_count and g.candidate_count=r.candidate_count order by r.created_at desc limit 1;
revoke all on public.current_verified_theme_census_receipt_v8 from public,anon,authenticated;
grant select on public.current_verified_theme_census_receipt_v8 to service_role;

create view public.verified_theme_monthly_metrics_v8
with (security_invoker=true)
as
with receipt as (select * from public.current_verified_theme_census_receipt_v8), months as (
  select substring(v.article_date from '^[0-9]{4}-[0-9]{2}') month_key,count(*)::integer corpus_articles
  from public.formal_verified_article_text_v5 v cross join receipt r
  where v.article_date ~ '^[0-9]{4}-[0-9]{2}' group by substring(v.article_date from '^[0-9]{4}-[0-9]{2}')
), support as (
  select x.candidate_id,substring(v.article_date from '^[0-9]{4}-[0-9]{2}') month_key,count(distinct x.article_id)::integer support_articles,avg(x.mapping_confidence)::numeric avg_confidence
  from public.verified_theme_census_relations_v7 x join receipt r on r.analysis_run_id=x.analysis_run_id join public.formal_verified_article_text_v5 v on v.article_id=x.article_id
  where v.article_date ~ '^[0-9]{4}-[0-9]{2}' group by x.candidate_id,substring(v.article_date from '^[0-9]{4}-[0-9]{2}')
), grid as (
  select c.id candidate_id,m.month_key,m.corpus_articles,coalesce(s.support_articles,0)::integer support_articles,coalesce(s.avg_confidence,0)::numeric avg_confidence
  from public.verified_theme_candidates_v7 c join receipt r on r.analysis_run_id=c.analysis_run_id cross join months m left join support s on s.candidate_id=c.id and s.month_key=m.month_key
)
select candidate_id,month_key,corpus_articles,support_articles,case when corpus_articles>0 then support_articles::numeric/corpus_articles else 0 end penetration_rate,avg_confidence,
       dense_rank() over(order by month_key)::integer month_ordinal
from grid;
revoke all on public.verified_theme_monthly_metrics_v8 from public,anon,authenticated;
grant select on public.verified_theme_monthly_metrics_v8 to service_role;

create view public.verified_theme_metrics_v8
with (security_invoker=true)
as
with receipt as (select * from public.current_verified_theme_census_receipt_v8), base as (
  select c.id candidate_id,c.theme_key,c.title,c.definition,c.inclusion_rule,c.exclusion_rule,c.subject,c.measurement,
         count(distinct r.article_id)::integer support_article_count,coalesce(avg(r.mapping_confidence),0)::numeric avg_mapping_confidence
  from public.verified_theme_candidates_v7 c join receipt x on x.analysis_run_id=c.analysis_run_id left join public.verified_theme_census_relations_v7 r on r.analysis_run_id=c.analysis_run_id and r.candidate_id=c.id
  group by c.id,c.theme_key,c.title,c.definition,c.inclusion_rule,c.exclusion_rule,c.subject,c.measurement
), monthly as (
  select m.candidate_id,count(*) filter(where m.support_articles>0)::integer active_month_count,min(m.month_key) filter(where m.support_articles>0) first_active_month,max(m.month_key) filter(where m.support_articles>0) last_active_month,
         max(m.penetration_rate)::numeric peak_monthly_penetration,
         regr_slope(m.penetration_rate::double precision,m.month_ordinal::double precision)::numeric penetration_trend_slope
  from public.verified_theme_monthly_metrics_v8 m group by m.candidate_id
)
select b.*,x.article_count corpus_article_count,case when x.article_count>0 then b.support_article_count::numeric/x.article_count else 0 end support_ratio,
       coalesce(m.active_month_count,0)::integer active_month_count,m.first_active_month,m.last_active_month,coalesce(m.peak_monthly_penetration,0)::numeric peak_monthly_penetration,coalesce(m.penetration_trend_slope,0)::numeric penetration_trend_slope
from base b cross join receipt x left join monthly m on m.candidate_id=b.candidate_id;
revoke all on public.verified_theme_metrics_v8 from public,anon,authenticated;
grant select on public.verified_theme_metrics_v8 to service_role;

create view public.verified_theme_deterministic_evidence_v8
with (security_invoker=true)
as
with receipt as (select * from public.current_verified_theme_census_receipt_v8), src as (
  select r.candidate_id,r.article_id,r.mapping_confidence,r.mapper_source_anchor,r.critic_source_anchor,v.article_date,v.analysis_text_sha256,
         row_number() over(partition by r.candidate_id order by r.mapping_confidence desc,v.article_date nulls last,r.article_id) strongest_rank,
         row_number() over(partition by r.candidate_id order by v.article_date nulls last,r.mapping_confidence desc,r.article_id) earliest_rank,
         row_number() over(partition by r.candidate_id order by v.article_date desc nulls last,r.mapping_confidence desc,r.article_id) latest_rank
  from public.verified_theme_census_relations_v7 r join receipt x on x.analysis_run_id=r.analysis_run_id join public.formal_verified_article_text_v5 v on v.article_id=r.article_id
), tagged as (
  select *,array_remove(array[case when strongest_rank=1 then 'strongest' end,case when earliest_rank=1 then 'earliest' end,case when latest_rank=1 then 'latest' end],null)::text[] evidence_roles
  from src where strongest_rank=1 or earliest_rank=1 or latest_rank=1
)
select candidate_id,article_id,article_date,mapping_confidence,mapper_source_anchor,critic_source_anchor,analysis_text_sha256,evidence_roles from tagged;
revoke all on public.verified_theme_deterministic_evidence_v8 from public,anon,authenticated;
grant select on public.verified_theme_deterministic_evidence_v8 to service_role;

commit;
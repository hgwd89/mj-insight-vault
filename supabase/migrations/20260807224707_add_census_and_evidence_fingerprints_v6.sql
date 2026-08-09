create or replace view public.theme_census_metrics_v6
with (security_invoker=true)
as
with base as (
  select a.id analysis_run_id,a.expected_article_count,c.id candidate_id,c.theme_key,c.title,c.definition,
         r.article_id,r.relation,r.subject,r.measurement,public.consumer_relevance_v4(r.subject,r.measurement) consumer_relevance,
         g.page_identity_source_image_id,g.article_date,r.confidence
  from public.theme_analysis_runs_v4 a
  join public.theme_candidates_v4 c on c.analysis_run_id=a.id
  join public.theme_census_relations_v4 r on r.analysis_run_id=a.id and r.candidate_id=c.id
  join public.formal_source_grounded_articles_v4 g on g.article_id=r.article_id
  where public.theme_census_integrity_v5(a.id)
)
select analysis_run_id,candidate_id,theme_key,title,max(definition) definition,max(expected_article_count) total_articles,
 count(*) filter(where relation='support') support_count,
 count(*) filter(where relation='counter') counter_count,
 count(*) filter(where relation='related_not_supporting') related_not_supporting_count,
 count(*) filter(where relation='none') none_count,
 count(*) filter(where relation='support' and consumer_relevance='direct') direct_consumer_support_count,
 count(*) filter(where relation='support' and consumer_relevance='indirect') indirect_consumer_support_count,
 count(*) filter(where relation='support' and consumer_relevance='none') non_consumer_support_count,
 count(distinct page_identity_source_image_id) filter(where relation='support') support_page_count,
 count(distinct left(article_date,10)) filter(where relation='support' and article_date ~ '^\d{4}-\d{2}-\d{2}') support_day_count,
 round(count(*) filter(where relation='support')::numeric/nullif(max(expected_article_count),0)*100,3) support_share_pct,
 round(count(*) filter(where relation='counter')::numeric/nullif(max(expected_article_count),0)*100,3) counter_share_pct,
 round(count(*) filter(where relation='support' and consumer_relevance='direct')::numeric/nullif(count(*) filter(where relation='support'),0)*100,3) direct_share_of_support_pct,
 round(avg(confidence) filter(where relation='support'),4) support_avg_confidence
from base group by analysis_run_id,candidate_id,theme_key,title;

revoke all on public.theme_census_metrics_v6 from public,anon,authenticated;
grant select on public.theme_census_metrics_v6 to service_role;

create or replace view public.theme_major_selection_v6
with (security_invoker=true)
as
with eligible as (
 select m.*,
   row_number() over(partition by analysis_run_id order by support_count desc,direct_consumer_support_count desc,support_page_count desc,support_day_count desc,counter_share_pct asc,theme_key) selection_rank
 from public.theme_census_metrics_v6 m
 where support_count>=4 and support_page_count>=3 and support_day_count>=2 and direct_consumer_support_count>=2
)
select *,selection_rank<=6 as selected_for_report from eligible;

revoke all on public.theme_major_selection_v6 from public,anon,authenticated;
grant select on public.theme_major_selection_v6 to service_role;

create or replace view public.theme_deterministic_evidence_v6
with (security_invoker=true)
as
with raw as (
 select r.analysis_run_id,r.candidate_id,c.theme_key,r.article_id,r.relation,r.subject,r.measurement,r.confidence,
        r.source_region_anchor,r.source_block_index,r.source_block_sha256,r.source_region_sha256,
        g.page_identity_source_image_id,g.article_date,
        public.consumer_relevance_v4(r.subject,r.measurement) consumer_relevance
 from public.theme_census_relations_v4 r
 join public.theme_candidates_v4 c on c.id=r.candidate_id
 join public.formal_source_grounded_articles_v4 g on g.article_id=r.article_id
 join public.theme_major_selection_v6 s on s.analysis_run_id=r.analysis_run_id and s.candidate_id=r.candidate_id and s.selected_for_report
 where r.relation in ('support','counter') and public.theme_census_integrity_v5(r.analysis_run_id)
), per_page as (
 select *,row_number() over(partition by analysis_run_id,candidate_id,relation,page_identity_source_image_id order by
   case consumer_relevance when 'direct' then 0 when 'indirect' then 1 when 'unclear' then 2 else 3 end,
   confidence desc,article_date desc,article_id) page_rank
 from raw
), ranked as (
 select *,row_number() over(partition by analysis_run_id,candidate_id,relation order by
   case consumer_relevance when 'direct' then 0 when 'indirect' then 1 when 'unclear' then 2 else 3 end,
   confidence desc,article_date desc,page_identity_source_image_id,article_id) evidence_rank
 from per_page where page_rank=1
)
select * from ranked where (relation='support' and evidence_rank<=5) or (relation='counter' and evidence_rank<=3);

revoke all on public.theme_deterministic_evidence_v6 from public,anon,authenticated;
grant select on public.theme_deterministic_evidence_v6 to service_role;

create or replace function public.theme_census_identity_fingerprint_v6(p_analysis_run_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
select case when public.theme_census_integrity_v5(p_analysis_run_id) then
 encode(extensions.digest(convert_to(coalesce(string_agg(
   jsonb_build_array(c.theme_key,r.article_id::text,r.relation,coalesce(r.subject,''),coalesce(r.measurement,''),coalesce(r.source_region_anchor,''),coalesce(r.source_block_index::text,''),coalesce(r.source_block_sha256,''),r.source_region_sha256,r.confidence,r.rationale)::text,
   '|' order by c.theme_key,r.article_id::text),'') ,'UTF8'),'sha256'),'hex')
 else null end
from public.theme_census_relations_v4 r join public.theme_candidates_v4 c on c.id=r.candidate_id
where r.analysis_run_id=p_analysis_run_id;
$$;

create or replace function public.theme_metrics_fingerprint_v6(p_analysis_run_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
select case when public.theme_census_integrity_v5(p_analysis_run_id) then
 encode(extensions.digest(convert_to(coalesce(string_agg(jsonb_build_array(theme_key,support_count,counter_count,direct_consumer_support_count,support_page_count,support_day_count,support_share_pct,counter_share_pct,direct_share_of_support_pct,support_avg_confidence)::text,'|' order by theme_key),''),'UTF8'),'sha256'),'hex')
 else null end
from public.theme_census_metrics_v6 where analysis_run_id=p_analysis_run_id;
$$;

create or replace function public.theme_selection_fingerprint_v6(p_analysis_run_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
select case when public.theme_census_integrity_v5(p_analysis_run_id) then
 encode(extensions.digest(convert_to(coalesce(string_agg(jsonb_build_array(theme_key,selection_rank,support_count,counter_count,direct_consumer_support_count,support_page_count,support_day_count)::text,'|' order by selection_rank,theme_key),''),'UTF8'),'sha256'),'hex')
 else null end
from public.theme_major_selection_v6 where analysis_run_id=p_analysis_run_id and selected_for_report;
$$;

create or replace function public.theme_evidence_fingerprint_v6(p_analysis_run_id uuid)
returns text
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
select case when public.theme_census_integrity_v5(p_analysis_run_id) then
 encode(extensions.digest(convert_to(coalesce(string_agg(jsonb_build_array(theme_key,relation,evidence_rank,article_id::text,page_identity_source_image_id::text,source_region_sha256,source_block_index,source_block_sha256,confidence)::text,'|' order by theme_key,relation,evidence_rank,article_id::text),''),'UTF8'),'sha256'),'hex')
 else null end
from public.theme_deterministic_evidence_v6 where analysis_run_id=p_analysis_run_id;
$$;

create table if not exists public.theme_analysis_proof_receipts_v6 (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references public.theme_analysis_runs_v4(id) on delete cascade,
  candidate_set_fingerprint text not null check(candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),
  census_identity_fingerprint text not null check(census_identity_fingerprint ~ '^[0-9a-f]{64}$'),
  metrics_fingerprint text not null check(metrics_fingerprint ~ '^[0-9a-f]{64}$'),
  selection_fingerprint text not null check(selection_fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_fingerprint text not null check(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_count integer not null check(candidate_count>0),
  selected_theme_count integer not null check(selected_theme_count>=0),
  census_cell_count bigint not null check(census_cell_count>0),
  evidence_count integer not null check(evidence_count>=0),
  ranking_version text not null default 'theme_ranking_v6_deterministic',
  created_at timestamptz not null default now()
);
alter table public.theme_analysis_proof_receipts_v6 enable row level security;
revoke all on public.theme_analysis_proof_receipts_v6 from public,anon,authenticated,service_role;

create or replace function public.seal_theme_analysis_v6(p_analysis_run_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare a public.theme_analysis_runs_v4%rowtype;v_census text;v_metrics text;v_selection text;v_evidence text;v_candidates integer;v_selected integer;v_cells bigint;v_evidence_count integer;v_id uuid;begin
  select * into a from public.theme_analysis_runs_v4 where id=p_analysis_run_id for update;
  if not found or not public.theme_census_integrity_v5(a.id) then raise exception 'theme_v6_census_not_integral'; end if;
  if a.candidate_set_fingerprint<>public.theme_candidate_set_fingerprint_v4(a.id) then raise exception 'theme_v6_candidate_set_stale'; end if;
  v_census:=public.theme_census_identity_fingerprint_v6(a.id);v_metrics:=public.theme_metrics_fingerprint_v6(a.id);v_selection:=public.theme_selection_fingerprint_v6(a.id);v_evidence:=public.theme_evidence_fingerprint_v6(a.id);
  if v_census is null or v_metrics is null or v_selection is null or v_evidence is null then raise exception 'theme_v6_fingerprint_missing'; end if;
  select count(*)::integer into v_candidates from public.theme_candidates_v4 where analysis_run_id=a.id;
  select count(*)::integer into v_selected from public.theme_major_selection_v6 where analysis_run_id=a.id and selected_for_report;
  select count(*)::bigint into v_cells from public.theme_census_relations_v4 where analysis_run_id=a.id;
  select count(*)::integer into v_evidence_count from public.theme_deterministic_evidence_v6 where analysis_run_id=a.id;
  insert into public.theme_analysis_proof_receipts_v6(analysis_run_id,candidate_set_fingerprint,census_identity_fingerprint,metrics_fingerprint,selection_fingerprint,evidence_fingerprint,candidate_count,selected_theme_count,census_cell_count,evidence_count)
  values(a.id,a.candidate_set_fingerprint,v_census,v_metrics,v_selection,v_evidence,v_candidates,v_selected,v_cells,v_evidence_count)
  on conflict(analysis_run_id) do update set candidate_set_fingerprint=excluded.candidate_set_fingerprint,census_identity_fingerprint=excluded.census_identity_fingerprint,metrics_fingerprint=excluded.metrics_fingerprint,selection_fingerprint=excluded.selection_fingerprint,evidence_fingerprint=excluded.evidence_fingerprint,candidate_count=excluded.candidate_count,selected_theme_count=excluded.selected_theme_count,census_cell_count=excluded.census_cell_count,evidence_count=excluded.evidence_count,ranking_version=excluded.ranking_version,created_at=now()
  returning id into v_id;
  update public.theme_analysis_runs_v4 set status='ranked',ranking_version='theme_ranking_v6_deterministic',updated_at=now() where id=a.id;
  return jsonb_build_object('status','sealed','proof_receipt_id',v_id,'candidate_count',v_candidates,'selected_theme_count',v_selected,'census_cell_count',v_cells,'evidence_count',v_evidence_count);
end $$;

create or replace function public.theme_analysis_proof_integrity_v6(p_analysis_run_id uuid)
returns boolean
language sql stable security definer
set search_path=pg_catalog,public
as $$
select exists(
 select 1 from public.theme_analysis_proof_receipts_v6 p join public.theme_analysis_runs_v4 a on a.id=p.analysis_run_id
 where p.analysis_run_id=p_analysis_run_id
   and public.theme_census_integrity_v5(a.id)
   and p.candidate_set_fingerprint=a.candidate_set_fingerprint
   and p.candidate_set_fingerprint=public.theme_candidate_set_fingerprint_v4(a.id)
   and p.census_identity_fingerprint=public.theme_census_identity_fingerprint_v6(a.id)
   and p.metrics_fingerprint=public.theme_metrics_fingerprint_v6(a.id)
   and p.selection_fingerprint=public.theme_selection_fingerprint_v6(a.id)
   and p.evidence_fingerprint=public.theme_evidence_fingerprint_v6(a.id)
   and p.candidate_count=(select count(*) from public.theme_candidates_v4 c where c.analysis_run_id=a.id)
   and p.selected_theme_count=(select count(*) from public.theme_major_selection_v6 s where s.analysis_run_id=a.id and s.selected_for_report)
   and p.census_cell_count=(select count(*) from public.theme_census_relations_v4 r where r.analysis_run_id=a.id)
   and p.evidence_count=(select count(*) from public.theme_deterministic_evidence_v6 e where e.analysis_run_id=a.id)
);
$$;

revoke execute on function public.seal_theme_analysis_v6(uuid) from public,anon,authenticated;
grant execute on function public.seal_theme_analysis_v6(uuid) to service_role;
revoke execute on function public.theme_census_identity_fingerprint_v6(uuid),public.theme_metrics_fingerprint_v6(uuid),public.theme_selection_fingerprint_v6(uuid),public.theme_evidence_fingerprint_v6(uuid),public.theme_analysis_proof_integrity_v6(uuid) from public,anon,authenticated;
grant execute on function public.theme_census_identity_fingerprint_v6(uuid),public.theme_metrics_fingerprint_v6(uuid),public.theme_selection_fingerprint_v6(uuid),public.theme_evidence_fingerprint_v6(uuid),public.theme_analysis_proof_integrity_v6(uuid) to service_role;
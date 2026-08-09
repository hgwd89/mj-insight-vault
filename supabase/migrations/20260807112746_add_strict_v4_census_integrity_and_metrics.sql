create or replace function public.anchor_grounded_unique_v4(p_text text,p_anchor text)
returns boolean
language plpgsql
immutable
set search_path to 'pg_catalog','public'
as $function$
declare
  t text:=lower(regexp_replace(coalesce(p_text,''),'\s+',' ','g'));
  a text:=lower(regexp_replace(btrim(coalesce(p_anchor,'')),'\s+',' ','g'));
  occurrences integer;
begin
  if length(a)<8 or position(a in t)=0 then return false; end if;
  occurrences:=(length(t)-length(replace(t,a,'')))/greatest(length(a),1);
  return occurrences=1;
end;
$function$;

create or replace function public.theme_census_integrity_v4(p_analysis_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with ar as (
  select * from public.theme_analysis_runs_v4 where id=p_analysis_run_id
), scan_ok as (
  select a.*,public.full_corpus_run_integrity_v4(a.scan_run_id) scan_valid,
         public.theme_candidate_set_fingerprint_v4(a.id) current_candidate_fingerprint
  from ar a
), reviews as (
  select r.article_id,r.source_clean_body_sha256,r.source_region_sha256
  from scan_ok a join public.full_corpus_article_reviews_v4 r on r.run_id=a.scan_run_id
), candidates as (
  select c.* from public.theme_candidates_v4 c where c.analysis_run_id=p_analysis_run_id
), batches as (
  select b.* from public.theme_census_batches_v4 b where b.analysis_run_id=p_analysis_run_id
), assigned as (
  select b.id batch_id,b.batch_index,u.article_id
  from batches b cross join lateral unnest(b.article_ids) u(article_id)
), relations as (
  select x.*,v.analysis_body,g.source_region_text,g.source_region_sha256 current_source_region_sha256,v.analysis_body_sha256 current_clean_body_sha256
  from public.theme_census_relations_v4 x
  left join public.formal_article_analysis_text_v2 v on v.article_id=x.article_id
  left join public.formal_source_grounded_articles_v1 g on g.article_id=x.article_id
  where x.analysis_run_id=p_analysis_run_id
), relation_validity as (
  select r.*,
    r.current_clean_body_sha256=r.source_clean_body_sha256
    and r.current_source_region_sha256=r.source_region_sha256
    and (
      (r.relation='none' and coalesce(btrim(r.clean_body_anchor),'')='' and coalesce(btrim(r.source_region_anchor),'')='')
      or
      (r.relation<>'none'
       and public.anchor_grounded_unique_v4(r.analysis_body,r.clean_body_anchor)
       and public.anchor_grounded_unique_v4(r.source_region_text,r.source_region_anchor))
    ) valid
  from relations r
), seed_counts as (
  select a.id analysis_run_id,
         (select count(*) from public.full_corpus_theme_seeds_v4 s where s.run_id=a.scan_run_id) actual_seed_count,
         (select count(*) from public.theme_seed_mappings_v4 m where m.analysis_run_id=a.id) mapping_count
  from scan_ok a
)
select exists(
  select 1 from scan_ok a cross join seed_counts sc
  where a.scan_valid
    and a.candidate_set_locked_at is not null
    and coalesce(a.candidate_set_fingerprint,'')<>''
    and a.candidate_set_fingerprint=a.current_candidate_fingerprint
    and a.expected_article_count=(select count(*) from reviews)
    and a.expected_seed_count=sc.actual_seed_count
    and sc.mapping_count=sc.actual_seed_count
    and (select count(*) from candidates)>0
    and not exists(select 1 from batches where candidate_set_fingerprint<>a.candidate_set_fingerprint or status<>'completed' or article_count<>cardinality(article_ids))
    and (select count(*) from assigned)=a.expected_article_count
    and (select count(distinct article_id) from assigned)=a.expected_article_count
    and not exists(select 1 from assigned x left join reviews r on r.article_id=x.article_id where r.article_id is null)
    and not exists(select 1 from reviews r left join assigned x on x.article_id=r.article_id where x.article_id is null)
    and (select count(*) from relation_validity)=a.expected_article_count*(select count(*) from candidates)
    and not exists(select 1 from relation_validity where not valid)
    and not exists(select 1 from relation_validity r left join candidates c on c.id=r.candidate_id where c.id is null)
    and not exists(select 1 from relation_validity r left join assigned x on x.batch_id=r.census_batch_id and x.article_id=r.article_id where x.article_id is null)
    and not exists(
      select 1 from reviews r cross join candidates c
      where not exists(select 1 from relation_validity x where x.article_id=r.article_id and x.candidate_id=c.id)
    )
    and not exists(
      select 1 from candidates c
      where (select count(*) from relation_validity r where r.candidate_id=c.id)<>a.expected_article_count
    )
);
$function$;

create or replace function public.enforce_theme_analysis_terminal_status_v4()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  if new.status in ('census_completed','ranked','completed')
     and (old.status is distinct from new.status or tg_op='INSERT')
     and not public.theme_census_integrity_v4(new.id) then
    raise exception using errcode='23514',message='theme_census_integrity_required';
  end if;
  if new.status in ('ranked','completed') and coalesce(new.ranking_version,'')='' then
    raise exception using errcode='23514',message='theme_ranking_version_required';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_enforce_theme_analysis_terminal_status_v4 on public.theme_analysis_runs_v4;
create trigger trg_enforce_theme_analysis_terminal_status_v4 before insert or update of status,ranking_version on public.theme_analysis_runs_v4 for each row execute function public.enforce_theme_analysis_terminal_status_v4();

create or replace view public.theme_census_metrics_v4
with (security_invoker=true)
as
with base as (
  select a.id analysis_run_id,a.expected_article_count,c.id candidate_id,c.theme_key,c.title,c.definition,
         r.article_id,r.relation,r.subject,r.measurement,
         public.consumer_relevance_v4(r.subject,r.measurement) consumer_relevance,
         g.source_image_id,g.article_date
  from public.theme_analysis_runs_v4 a
  join public.theme_candidates_v4 c on c.analysis_run_id=a.id
  join public.theme_census_relations_v4 r on r.analysis_run_id=a.id and r.candidate_id=c.id
  join public.formal_source_grounded_articles_v1 g on g.article_id=r.article_id
  where public.theme_census_integrity_v4(a.id)
)
select analysis_run_id,candidate_id,theme_key,title,max(definition) definition,max(expected_article_count) total_articles,
       count(*) filter(where relation='support') support_count,
       count(*) filter(where relation='counter') counter_count,
       count(*) filter(where relation='related_not_supporting') related_not_supporting_count,
       count(*) filter(where relation='none') none_count,
       count(*) filter(where relation='support' and consumer_relevance='direct') direct_consumer_support_count,
       count(*) filter(where relation='support' and consumer_relevance='indirect') indirect_consumer_support_count,
       count(*) filter(where relation='support' and consumer_relevance='none') non_consumer_support_count,
       count(distinct source_image_id) filter(where relation='support') support_source_page_count,
       count(distinct substring(article_date from 1 for 7)) filter(where relation='support' and article_date~'^\d{4}-\d{2}') support_month_count,
       round((count(*) filter(where relation='support')::numeric/nullif(max(expected_article_count),0))*100,3) support_share_pct,
       round((count(*) filter(where relation='counter')::numeric/nullif(max(expected_article_count),0))*100,3) counter_share_pct,
       round((count(*) filter(where relation='support' and consumer_relevance='direct')::numeric/nullif(count(*) filter(where relation='support'),0))*100,3) direct_share_of_support_pct
from base
group by analysis_run_id,candidate_id,theme_key,title;

revoke all on public.theme_census_metrics_v4 from public,anon,authenticated;
grant select on public.theme_census_metrics_v4 to postgres,service_role;

revoke all on function public.anchor_grounded_unique_v4(text,text),public.theme_census_integrity_v4(uuid),public.enforce_theme_analysis_terminal_status_v4() from public,anon,authenticated;
grant execute on function public.anchor_grounded_unique_v4(text,text),public.theme_census_integrity_v4(uuid),public.enforce_theme_analysis_terminal_status_v4() to postgres,service_role;
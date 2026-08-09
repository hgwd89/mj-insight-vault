alter table public.article_classification_jobs add column if not exists source_analysis_text_sha256 text;
alter table public.article_profiles add column if not exists source_analysis_text_sha256 text;
alter table public.article_category_memberships add column if not exists source_analysis_text_sha256 text;

update public.article_classification_jobs j
set source_analysis_text_sha256=a.analysis_text_sha256
from public.articles a
where a.id=j.article_id
  and j.source_analysis_text_sha256 is null
  and coalesce(a.analysis_text_sha256,'') ~ '^[0-9a-f]{64}$'
  and (j.status<>'completed' or j.finished_at is null or a.updated_at<=j.finished_at);

update public.article_profiles p
set source_analysis_text_sha256=a.analysis_text_sha256
from public.articles a
where a.id=p.article_id
  and p.profile_model='article_category_profile_v2'
  and p.source_analysis_text_sha256 is null
  and coalesce(a.analysis_text_sha256,'') ~ '^[0-9a-f]{64}$'
  and a.updated_at<=p.updated_at;

update public.article_category_memberships m
set source_analysis_text_sha256=a.analysis_text_sha256
from public.articles a
join public.article_profiles p on p.article_id=a.id and p.profile_model='article_category_profile_v2'
where a.id=m.article_id
  and m.source='article_category_profile_v2'
  and m.source_analysis_text_sha256 is null
  and p.source_analysis_text_sha256=a.analysis_text_sha256;

create or replace function public.stamp_classification_job_source_hash_v1()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public'
as $function$
declare v_hash text;
begin
  if tg_op='INSERT' or new.status='queued' then
    select a.analysis_text_sha256 into v_hash from public.articles a where a.id=new.article_id;
    if coalesce(v_hash,'') !~ '^[0-9a-f]{64}$' then raise exception using errcode='23514',message='classification_source_hash_unavailable'; end if;
    new.source_analysis_text_sha256:=v_hash;
  end if;
  return new;
end;
$function$;

create or replace function public.enforce_classification_completion_source_hash_v1()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public'
as $function$
declare v_hash text;
begin
  if new.status='completed' and (tg_op='INSERT' or old.status is distinct from 'completed') then
    select a.analysis_text_sha256 into v_hash from public.formal_corpus_articles_v1 a where a.id=new.article_id;
    if coalesce(v_hash,'')='' then raise exception using errcode='23514',message='classification_article_not_formal'; end if;
    if coalesce(new.source_analysis_text_sha256,'')<>v_hash then raise exception using errcode='23514',message='classification_source_hash_changed'; end if;
  end if;
  return new;
end;
$function$;

create or replace function public.stamp_article_profile_source_hash_v1()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public'
as $function$
declare v_hash text;
begin
  if new.profile_model='article_category_profile_v2' then
    select a.analysis_text_sha256 into v_hash from public.articles a where a.id=new.article_id;
    if coalesce(v_hash,'') !~ '^[0-9a-f]{64}$' then raise exception using errcode='23514',message='profile_source_hash_unavailable'; end if;
    new.source_analysis_text_sha256:=v_hash;
  end if;
  return new;
end;
$function$;

create or replace function public.stamp_category_membership_source_hash_v1()
returns trigger language plpgsql security definer set search_path to 'pg_catalog','public'
as $function$
declare v_hash text;
begin
  if new.source='article_category_profile_v2' then
    select a.analysis_text_sha256 into v_hash from public.articles a where a.id=new.article_id;
    if coalesce(v_hash,'') !~ '^[0-9a-f]{64}$' then raise exception using errcode='23514',message='membership_source_hash_unavailable'; end if;
    new.source_analysis_text_sha256:=v_hash;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_00_stamp_classification_job_source_hash_v1 on public.article_classification_jobs;
create trigger trg_00_stamp_classification_job_source_hash_v1 before insert or update of status,article_id on public.article_classification_jobs for each row execute function public.stamp_classification_job_source_hash_v1();
drop trigger if exists trg_zz_enforce_classification_completion_source_hash_v1 on public.article_classification_jobs;
create trigger trg_zz_enforce_classification_completion_source_hash_v1 before insert or update of status on public.article_classification_jobs for each row execute function public.enforce_classification_completion_source_hash_v1();
drop trigger if exists trg_00_stamp_article_profile_source_hash_v1 on public.article_profiles;
create trigger trg_00_stamp_article_profile_source_hash_v1 before insert or update of article_id,profile_model,profile_json on public.article_profiles for each row execute function public.stamp_article_profile_source_hash_v1();
drop trigger if exists trg_00_stamp_category_membership_source_hash_v1 on public.article_category_memberships;
create trigger trg_00_stamp_category_membership_source_hash_v1 before insert or update of article_id,source,score,confidence,match_terms,reason on public.article_category_memberships for each row execute function public.stamp_category_membership_source_hash_v1();

revoke all on function public.stamp_classification_job_source_hash_v1() from public,anon,authenticated;
revoke all on function public.enforce_classification_completion_source_hash_v1() from public,anon,authenticated;
revoke all on function public.stamp_article_profile_source_hash_v1() from public,anon,authenticated;
revoke all on function public.stamp_category_membership_source_hash_v1() from public,anon,authenticated;
grant execute on function public.stamp_classification_job_source_hash_v1() to postgres,service_role;
grant execute on function public.enforce_classification_completion_source_hash_v1() to postgres,service_role;
grant execute on function public.stamp_article_profile_source_hash_v1() to postgres,service_role;
grant execute on function public.stamp_category_membership_source_hash_v1() to postgres,service_role;

create or replace view public.category_classification_gate_v2 with (security_invoker=true) as
with formal as (
  select id,analysis_text_sha256 from public.formal_corpus_articles_v1
), profiled as (
  select distinct p.article_id from public.article_profiles p join formal f on f.id=p.article_id
  where p.profile_model='article_category_profile_v2' and p.source_analysis_text_sha256=f.analysis_text_sha256
), categorized as (
  select distinct m.article_id from public.article_category_memberships m join formal f on f.id=m.article_id
  where m.source='article_category_profile_v2' and m.source_analysis_text_sha256=f.analysis_text_sha256
), invalid_memberships as (
  select count(*)::integer n from public.article_category_memberships m join formal f on f.id=m.article_id
  left join public.analysis_categories c on c.id=m.category_id and c.is_active=true
  where m.source='article_category_profile_v2' and m.source_analysis_text_sha256=f.analysis_text_sha256 and c.id is null
), stale_profiles as (
  select count(*)::integer n from public.article_profiles p join formal f on f.id=p.article_id
  where p.profile_model='article_category_profile_v2' and coalesce(p.source_analysis_text_sha256,'')<>f.analysis_text_sha256
), stale_memberships as (
  select count(*)::integer n from public.article_category_memberships m join formal f on f.id=m.article_id
  where m.source='article_category_profile_v2' and coalesce(m.source_analysis_text_sha256,'')<>f.analysis_text_sha256
)
select
  (select count(*)::integer from formal) formal_article_count,
  (select count(*)::integer from profiled) profiled_article_count,
  (select count(*)::integer from categorized) categorized_article_count,
  (select count(*)::integer from formal f left join profiled p on p.article_id=f.id where p.article_id is null) unprofiled_article_count,
  (select count(*)::integer from formal f left join categorized c on c.article_id=f.id where c.article_id is null) uncategorized_article_count,
  (select n from invalid_memberships) invalid_membership_count,
  (select n from stale_profiles) stale_profile_count,
  (select n from stale_memberships) stale_membership_count,
  case when (select count(*) from formal)=0 then 'failed' when (select n from stale_profiles)>0 then 'failed' when (select n from stale_memberships)>0 then 'failed' when (select count(*) from formal)<>(select count(*) from profiled) then 'failed' when (select count(*) from formal)<>(select count(*) from categorized) then 'failed' when (select n from invalid_memberships)>0 then 'failed' else 'passed' end category_classification_gate,
  case when (select count(*) from formal)=0 then 'no_formal_articles' when (select n from stale_profiles)>0 then 'stale_profiles_exist' when (select n from stale_memberships)>0 then 'stale_memberships_exist' when (select count(*) from formal)<>(select count(*) from profiled) then 'unprofiled_articles_exist' when (select count(*) from formal)<>(select count(*) from categorized) then 'uncategorized_articles_exist' when (select n from invalid_memberships)>0 then 'inactive_or_missing_category_memberships_exist' else 'passed' end gate_reason;

revoke all on public.category_classification_gate_v2 from public,anon,authenticated;
grant select on public.category_classification_gate_v2 to postgres,service_role;

create or replace view public.corpus_scan_gate_view with (security_invoker=true) as
with current_all as (
  select count(*)::integer current_article_count from public.formal_corpus_articles_v1
), current_category as (
  select m.category_id,count(distinct a.id)::integer current_article_count
  from public.article_category_memberships m
  join public.formal_corpus_articles_v1 a on a.id=m.article_id and m.source_analysis_text_sha256=a.analysis_text_sha256
  join public.analysis_categories c on c.id=m.category_id and c.is_active=true
  where m.source='article_category_profile_v2'
  group by m.category_id
), classification as (
  select category_classification_gate,gate_reason from public.category_classification_gate_v2
)
select r.id,r.scope_type,r.scope_query,r.status,r.model,r.active_article_count,
  case when r.scope_type='all' then ca.current_article_count when r.scope_type='category' then coalesce(cc.current_article_count,0) else r.active_article_count end current_article_count,
  case when r.scope_type='all' then ca.current_article_count when r.scope_type='category' then coalesce(cc.current_article_count,0) else r.active_article_count end-r.active_article_count current_article_count_diff,
  r.ocr_ready_article_count,r.total_batches,r.completed_batches,r.failed_batches,r.needs_review_batches,r.analyzed_article_count,
  case
    when r.scope_type='category' and cl.category_classification_gate<>'passed' then 'failed'
    when r.scope_type='category' and not exists(select 1 from public.analysis_categories c where c.id=r.scope_query and c.is_active=true) then 'failed'
    when r.status='completed' and r.total_batches>0 and r.completed_batches=r.total_batches and r.failed_batches=0 and r.needs_review_batches=0 and r.analyzed_article_count=r.ocr_ready_article_count and r.ocr_ready_article_count=r.active_article_count and (case when r.scope_type='all' then ca.current_article_count when r.scope_type='category' then coalesce(cc.current_article_count,0) else r.active_article_count end)=r.active_article_count then 'passed'
    else 'failed'
  end full_corpus_gate,
  case
    when r.scope_type='category' and cl.category_classification_gate<>'passed' then 'category_classification_'||cl.gate_reason
    when r.scope_type='category' and not exists(select 1 from public.analysis_categories c where c.id=r.scope_query and c.is_active=true) then 'category_inactive_or_missing'
    when r.active_article_count=0 then 'no_articles'
    when (case when r.scope_type='all' then ca.current_article_count when r.scope_type='category' then coalesce(cc.current_article_count,0) else r.active_article_count end)<>r.active_article_count then 'run_stale_article_count_mismatch'
    when r.ocr_ready_article_count<>r.active_article_count then 'ocr_incomplete'
    when r.total_batches=0 then 'no_batches'
    when r.completed_batches<>r.total_batches then 'batches_incomplete'
    when r.failed_batches>0 then 'failed_batches_exist'
    when r.needs_review_batches>0 then 'needs_review_batches_exist'
    when r.analyzed_article_count<>r.ocr_ready_article_count then 'analyzed_count_mismatch'
    when r.status<>'completed' then 'run_not_completed'
    else 'passed'
  end gate_reason,
  r.created_at,r.updated_at,r.finished_at
from public.full_corpus_scan_runs r cross join current_all ca cross join classification cl left join current_category cc on cc.category_id=r.scope_query;

revoke all on public.corpus_scan_gate_view from public,anon,authenticated;
grant select on public.corpus_scan_gate_view to postgres,service_role;
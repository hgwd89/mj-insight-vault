drop view if exists public.corpus_scan_execution_priority_view;
drop view if exists public.analysis_readiness_view;
drop view if exists public.corpus_scan_gate_view;

create view public.corpus_scan_gate_view as
with current_all as (
  select count(*)::integer as current_article_count
  from public.articles a
  where (a.status is null or a.status not in ('deleted','excluded','rejected'))
    and coalesce(a.ocr_text,'') <> ''
), current_category as (
  select
    m.category_id,
    count(distinct a.id)::integer as current_article_count
  from public.article_category_memberships m
  join public.articles a on a.id = m.article_id
  where (a.status is null or a.status not in ('deleted','excluded','rejected'))
    and coalesce(a.ocr_text,'') <> ''
  group by m.category_id
)
select
  r.id,
  r.scope_type,
  r.scope_query,
  r.status,
  r.model,
  r.active_article_count,
  case
    when r.scope_type = 'all' then ca.current_article_count
    when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
    else r.active_article_count
  end as current_article_count,
  (case
    when r.scope_type = 'all' then ca.current_article_count
    when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
    else r.active_article_count
  end) - r.active_article_count as current_article_count_diff,
  r.ocr_ready_article_count,
  r.total_batches,
  r.completed_batches,
  r.failed_batches,
  r.needs_review_batches,
  r.analyzed_article_count,
  case
    when r.status = 'completed'
      and r.total_batches > 0
      and r.completed_batches = r.total_batches
      and r.failed_batches = 0
      and r.needs_review_batches = 0
      and r.analyzed_article_count = r.ocr_ready_article_count
      and r.ocr_ready_article_count = r.active_article_count
      and (case when r.scope_type = 'all' then ca.current_article_count when r.scope_type = 'category' then coalesce(cc.current_article_count, 0) else r.active_article_count end) = r.active_article_count
    then 'passed'
    else 'failed'
  end as full_corpus_gate,
  case
    when r.active_article_count = 0 then 'no_articles'
    when (case when r.scope_type = 'all' then ca.current_article_count when r.scope_type = 'category' then coalesce(cc.current_article_count, 0) else r.active_article_count end) <> r.active_article_count then 'run_stale_article_count_mismatch'
    when r.ocr_ready_article_count <> r.active_article_count then 'ocr_incomplete'
    when r.total_batches = 0 then 'no_batches'
    when r.completed_batches <> r.total_batches then 'batches_incomplete'
    when r.failed_batches > 0 then 'failed_batches_exist'
    when r.needs_review_batches > 0 then 'needs_review_batches_exist'
    when r.analyzed_article_count <> r.ocr_ready_article_count then 'analyzed_count_mismatch'
    when r.status <> 'completed' then 'run_not_completed'
    else 'passed'
  end as gate_reason,
  r.created_at,
  r.updated_at,
  r.finished_at
from public.full_corpus_scan_runs r
cross join current_all ca
left join current_category cc on cc.category_id = r.scope_query;

create view public.corpus_scan_execution_priority_view as
select
  id as run_id,
  scope_type,
  scope_query,
  status,
  active_article_count,
  current_article_count,
  current_article_count_diff,
  ocr_ready_article_count,
  total_batches,
  completed_batches,
  failed_batches,
  needs_review_batches,
  analyzed_article_count,
  full_corpus_gate,
  gate_reason,
  case
    when gate_reason = 'run_stale_article_count_mismatch' then 999999
    when scope_type = 'all' then 100000
    when scope_query = 'beauty_cosmetics' then 90000
    when scope_query = 'retail_channel' then 80000
    when scope_query = 'food_beverage' then 70000
    when scope_query = 'finance_value' then 65000
    else 50000
  end + active_article_count - completed_batches * 10 - failed_batches * 100 - needs_review_batches * 100 as priority_score,
  case
    when full_corpus_gate = 'passed' then 'done'
    when gate_reason = 'run_stale_article_count_mismatch' then 'stale_rebuild_required'
    when failed_batches > 0 or needs_review_batches > 0 then 'review_or_retry'
    when completed_batches = 0 then 'not_started'
    else 'in_progress'
  end as execution_state,
  created_at,
  updated_at
from public.corpus_scan_gate_view
where full_corpus_gate <> 'passed'
order by priority_score desc, active_article_count desc, created_at asc;

create view public.analysis_readiness_view as
with article_base as (
  select
    count(*) filter (where status is null or status not in ('deleted','excluded','rejected')) as active_article_count,
    count(*) filter (where (status is null or status not in ('deleted','excluded','rejected')) and coalesce(ocr_text,'') <> '') as ocr_ready_article_count
  from public.articles
), profile_base as (
  select
    count(*) as profiled_article_count,
    count(*) filter (where primary_category = 'uncategorized') as uncategorized_count,
    count(*) filter (where primary_category = 'cosmetics') as cosmetics_count,
    count(*) filter (where primary_category = 'food') as food_count,
    count(*) filter (where primary_category = 'retail') as retail_count,
    count(*) filter (where primary_category = 'digital') as digital_count,
    count(*) filter (where primary_category = 'healthcare') as healthcare_count
  from public.article_profiles
), scan_base as (
  select
    count(*) as scan_run_count,
    count(*) filter (where scope_type = 'all') as all_scan_run_count,
    count(*) filter (where scope_type = 'category') as category_scan_run_count,
    count(*) filter (where full_corpus_gate = 'passed') as passed_scan_count,
    count(*) filter (where full_corpus_gate = 'failed') as failed_scan_count,
    count(*) filter (where gate_reason = 'run_stale_article_count_mismatch') as stale_scan_count
  from public.corpus_scan_gate_view
), report_base as (
  select
    count(*) as report_count,
    count(*) filter (where answer_json->>'analysis_verification_status' = 'legacy_unverified') as legacy_unverified_report_count,
    count(*) filter (where answer_json->>'full_corpus_gate' = 'passed') as full_corpus_verified_report_count
  from public.chat_reports
)
select
  a.active_article_count,
  a.ocr_ready_article_count,
  p.profiled_article_count,
  p.uncategorized_count,
  p.cosmetics_count,
  p.food_count,
  p.retail_count,
  p.digital_count,
  p.healthcare_count,
  s.scan_run_count,
  s.all_scan_run_count,
  s.category_scan_run_count,
  s.passed_scan_count,
  s.failed_scan_count,
  s.stale_scan_count,
  r.report_count,
  r.legacy_unverified_report_count,
  r.full_corpus_verified_report_count,
  case
    when a.active_article_count = a.ocr_ready_article_count
      and a.active_article_count = p.profiled_article_count
      and s.all_scan_run_count >= 1
      and s.category_scan_run_count >= 1
      and s.stale_scan_count = 0
    then 'ready_for_scan_execution'
    else 'not_ready'
  end as readiness_status
from article_base a
cross join profile_base p
cross join scan_base s
cross join report_base r;
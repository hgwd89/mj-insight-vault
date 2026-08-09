create or replace view public.analysis_readiness_view as
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
    count(*) filter (where full_corpus_gate = 'failed') as failed_scan_count
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
  r.report_count,
  r.legacy_unverified_report_count,
  r.full_corpus_verified_report_count,
  case
    when a.active_article_count = a.ocr_ready_article_count
      and a.active_article_count = p.profiled_article_count
      and s.all_scan_run_count >= 1
      and s.category_scan_run_count >= 1
    then 'ready_for_scan_execution'
    else 'not_ready'
  end as readiness_status
from article_base a
cross join profile_base p
cross join scan_base s
cross join report_base r;
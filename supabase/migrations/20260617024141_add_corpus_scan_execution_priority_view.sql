create or replace view public.corpus_scan_execution_priority_view as
select
  id as run_id,
  scope_type,
  scope_query,
  status,
  active_article_count,
  ocr_ready_article_count,
  total_batches,
  completed_batches,
  failed_batches,
  needs_review_batches,
  analyzed_article_count,
  case
    when scope_type = 'all' then 100000
    when scope_query = 'beauty_cosmetics' then 90000
    when scope_query = 'retail_channel' then 80000
    when scope_query = 'food_beverage' then 70000
    when scope_query = 'finance_value' then 65000
    else 50000
  end
  + active_article_count
  - completed_batches * 10
  - failed_batches * 100
  - needs_review_batches * 100 as priority_score,
  case
    when status = 'completed'
      and completed_batches = total_batches
      and failed_batches = 0
      and needs_review_batches = 0
      and analyzed_article_count = ocr_ready_article_count
    then 'done'
    when failed_batches > 0 or needs_review_batches > 0 then 'review_or_retry'
    when completed_batches = 0 then 'not_started'
    else 'in_progress'
  end as execution_state,
  created_at,
  updated_at
from public.full_corpus_scan_runs
where not (
  status = 'completed'
  and completed_batches = total_batches
  and failed_batches = 0
  and needs_review_batches = 0
  and analyzed_article_count = ocr_ready_article_count
)
order by priority_score desc, active_article_count desc, created_at asc;
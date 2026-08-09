create or replace view public.category_analysis_readiness_view as
with category_counts as (
  select
    c.id as category_id,
    c.name_ja,
    c.description,
    count(m.article_id) as matched_article_count
  from public.analysis_categories c
  left join public.article_category_memberships m on m.category_id = c.id
  where c.is_active = true
  group by c.id, c.name_ja, c.description
), latest_runs as (
  select distinct on (scope_query)
    scope_query as category_id,
    id as run_id,
    status,
    active_article_count,
    ocr_ready_article_count,
    total_batches,
    completed_batches,
    failed_batches,
    needs_review_batches,
    analyzed_article_count,
    case
      when status = 'completed'
        and total_batches > 0
        and completed_batches = total_batches
        and failed_batches = 0
        and needs_review_batches = 0
        and analyzed_article_count = ocr_ready_article_count
        and ocr_ready_article_count = active_article_count
      then 'passed'
      else 'failed'
    end as category_full_corpus_gate,
    created_at,
    updated_at
  from public.full_corpus_scan_runs
  where scope_type = 'category'
  order by scope_query, created_at desc
)
select
  cc.category_id,
  cc.name_ja,
  cc.description,
  cc.matched_article_count,
  lr.run_id,
  coalesce(lr.status, 'not_created') as run_status,
  coalesce(lr.active_article_count, 0) as run_article_count,
  coalesce(lr.ocr_ready_article_count, 0) as ocr_ready_article_count,
  coalesce(lr.total_batches, 0) as total_batches,
  coalesce(lr.completed_batches, 0) as completed_batches,
  coalesce(lr.failed_batches, 0) as failed_batches,
  coalesce(lr.needs_review_batches, 0) as needs_review_batches,
  coalesce(lr.analyzed_article_count, 0) as analyzed_article_count,
  coalesce(lr.category_full_corpus_gate, 'failed') as category_full_corpus_gate,
  case
    when cc.matched_article_count = 0 then 'no_articles'
    when lr.run_id is null then 'scan_run_missing'
    when lr.active_article_count <> cc.matched_article_count then 'run_article_count_mismatch'
    when lr.total_batches = 0 then 'no_batches'
    when lr.completed_batches <> lr.total_batches then 'batches_incomplete'
    when lr.failed_batches > 0 then 'failed_batches_exist'
    when lr.needs_review_batches > 0 then 'needs_review_batches_exist'
    when lr.analyzed_article_count <> lr.ocr_ready_article_count then 'analyzed_count_mismatch'
    when lr.category_full_corpus_gate = 'passed' then 'passed'
    else 'failed'
  end as readiness_reason,
  lr.created_at as run_created_at,
  lr.updated_at as run_updated_at
from category_counts cc
left join latest_runs lr on lr.category_id = cc.category_id;
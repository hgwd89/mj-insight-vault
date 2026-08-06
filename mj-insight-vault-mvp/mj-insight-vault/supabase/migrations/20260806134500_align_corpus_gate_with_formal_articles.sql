-- The count gate must use the same article-only population as the scan creator.

create or replace view public.corpus_scan_gate_view
with (security_invoker = true)
as
with current_all as (
  select count(*)::integer as current_article_count
  from public.formal_corpus_articles_v1
),
current_category as (
  select m.category_id, count(distinct a.id)::integer as current_article_count
  from public.article_category_memberships m
  join public.formal_corpus_articles_v1 a on a.id = m.article_id
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
  case
    when r.scope_type = 'all' then ca.current_article_count
    when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
    else r.active_article_count
  end - r.active_article_count as current_article_count_diff,
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
      and case
        when r.scope_type = 'all' then ca.current_article_count
        when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
        else r.active_article_count
      end = r.active_article_count
      then 'passed'
    else 'failed'
  end as full_corpus_gate,
  case
    when r.active_article_count = 0 then 'no_articles'
    when case
      when r.scope_type = 'all' then ca.current_article_count
      when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
      else r.active_article_count
    end <> r.active_article_count then 'run_stale_article_count_mismatch'
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

revoke all on public.corpus_scan_gate_view from public, anon, authenticated;
grant select on public.corpus_scan_gate_view to postgres, service_role;

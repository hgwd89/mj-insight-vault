begin;

create or replace view public.ocr_verification_gate_v2
with (security_invoker=true)
as
with expected as (
  select expected_page_count page_count,expected_article_count article_count
  from public.source_region_inventory_gate_v6
), jobs as (
  select count(*)::integer jobs,
         count(*) filter(where status='completed')::integer completed,
         count(*) filter(where status='needs_review')::integer needs_review,
         count(*) filter(where status='failed')::integer failed,
         coalesce(sum(article_count) filter(where status='completed'),0)::integer verified
  from public.ocr_verification_page_jobs_v2 j
  join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id
)
select expected.page_count expected_pages,expected.article_count expected_articles,
       jobs.jobs,jobs.completed,jobs.needs_review,jobs.failed,jobs.verified,
       case
         when jobs.needs_review>0 or jobs.failed>0 then 'failed'
         when jobs.jobs<>expected.page_count or jobs.completed<>expected.page_count or jobs.verified<>expected.article_count then 'pending'
         else 'passed'
       end ocr_verification_gate
from expected cross join jobs;

revoke all on public.ocr_verification_gate_v2 from public,anon,authenticated;
grant select on public.ocr_verification_gate_v2 to service_role;

commit;
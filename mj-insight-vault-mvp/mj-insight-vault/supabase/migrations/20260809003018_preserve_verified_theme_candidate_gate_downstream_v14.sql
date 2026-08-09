create or replace view public.verified_theme_candidate_gate_v7
with (security_invoker=true)
as
with rr as (
  select id, seed_count
  from public.current_verified_article_review_corpus_receipt_v7
), a as (
  select ar.*
  from public.verified_theme_analysis_runs_v7 ar
  join rr on rr.id = ar.review_receipt_id
  order by ar.created_at desc
  limit 1
), chunks as (
  select
    count(*)::integer as jobs,
    count(*) filter (where j.status='completed')::integer as completed,
    count(*) filter (where j.status='needs_review')::integer as needs_review,
    count(*) filter (where j.status='failed')::integer as failed
  from public.verified_theme_seed_chunk_jobs_v7 j
  join a on a.id = j.analysis_run_id
), con as (
  select
    count(*)::integer as jobs,
    count(*) filter (where j.status='completed')::integer as completed,
    count(*) filter (where j.status='needs_review')::integer as needs_review,
    count(*) filter (where j.status='failed')::integer as failed
  from public.verified_theme_consolidation_jobs_v7 j
  join a on a.id = j.analysis_run_id
), cand as (
  select count(*)::integer as n
  from public.verified_theme_candidates_v7 c
  join a on a.id = c.analysis_run_id
)
select
  a.id as analysis_run_id,
  coalesce(rr.seed_count,0) as seed_count,
  coalesce(chunks.jobs,0) as seed_chunk_jobs,
  coalesce(chunks.completed,0) as completed_seed_chunks,
  coalesce(chunks.needs_review,0) as review_seed_chunks,
  coalesce(chunks.failed,0) as failed_seed_chunks,
  coalesce(con.jobs,0) as consolidation_jobs,
  coalesce(con.completed,0) as completed_consolidation_jobs,
  coalesce(cand.n,0) as candidate_count,
  a.candidate_set_fingerprint,
  case
    when a.id is null then 'failed'::text
    when rr.seed_count=0
      and a.status in ('candidates_ready','census','ranked')
      and cand.n=0
      and a.candidate_set_fingerprint ~ '^[0-9a-f]{64}$'
      then 'passed'::text
    when rr.seed_count>0
      and a.status in ('candidates_ready','census','ranked')
      and chunks.jobs>0
      and chunks.completed=chunks.jobs
      and chunks.needs_review=0
      and chunks.failed=0
      and con.jobs=1
      and con.completed=1
      and cand.n>0
      and a.candidate_set_fingerprint ~ '^[0-9a-f]{64}$'
      then 'passed'::text
    else 'failed'::text
  end as candidate_gate,
  case
    when a.id is null then 'verified_review_receipt_required'::text
    when chunks.needs_review>0 or con.needs_review>0 then 'theme_candidate_review_required'::text
    when chunks.failed>0 or con.failed>0 then 'theme_candidate_worker_failed'::text
    when rr.seed_count=0 and a.status in ('candidates_ready','census','ranked') then 'passed'::text
    when a.status not in ('candidates_ready','census','ranked') then 'theme_candidate_discovery_incomplete'::text
    when cand.n=0 then 'theme_candidates_missing'::text
    else 'passed'::text
  end as gate_reason
from (select 1) q
left join rr on true
left join a on true
left join chunks on true
left join con on true
left join cand on true;
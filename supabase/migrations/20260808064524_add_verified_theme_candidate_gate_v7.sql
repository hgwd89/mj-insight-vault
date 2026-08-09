begin;
create view public.verified_theme_candidate_gate_v7
with (security_invoker=true)
as
with rr as (select id,seed_count from public.current_verified_article_review_corpus_receipt_v7),
a as (
 select ar.* from public.verified_theme_analysis_runs_v7 ar join rr on rr.id=ar.review_receipt_id order by ar.created_at desc limit 1
), chunks as (
 select count(*)::integer jobs,count(*) filter(where j.status='completed')::integer completed,count(*) filter(where j.status='needs_review')::integer needs_review,count(*) filter(where j.status='failed')::integer failed
 from public.verified_theme_seed_chunk_jobs_v7 j join a on a.id=j.analysis_run_id
), con as (
 select count(*)::integer jobs,count(*) filter(where j.status='completed')::integer completed,count(*) filter(where j.status='needs_review')::integer needs_review,count(*) filter(where j.status='failed')::integer failed
 from public.verified_theme_consolidation_jobs_v7 j join a on a.id=j.analysis_run_id
), cand as (
 select count(*)::integer n from public.verified_theme_candidates_v7 c join a on a.id=c.analysis_run_id
)
select a.id analysis_run_id,coalesce(rr.seed_count,0)::integer seed_count,coalesce(chunks.jobs,0)::integer seed_chunk_jobs,coalesce(chunks.completed,0)::integer completed_seed_chunks,
       coalesce(chunks.needs_review,0)::integer review_seed_chunks,coalesce(chunks.failed,0)::integer failed_seed_chunks,
       coalesce(con.jobs,0)::integer consolidation_jobs,coalesce(con.completed,0)::integer completed_consolidation_jobs,
       coalesce(cand.n,0)::integer candidate_count,a.candidate_set_fingerprint,
       case when a.id is null then 'failed'
            when rr.seed_count=0 and a.status='candidates_ready' and cand.n=0 and a.candidate_set_fingerprint ~ '^[0-9a-f]{64}$' then 'passed'
            when rr.seed_count>0 and a.status='candidates_ready' and chunks.jobs>0 and chunks.completed=chunks.jobs and chunks.needs_review=0 and chunks.failed=0 and con.jobs=1 and con.completed=1 and cand.n>0 and a.candidate_set_fingerprint ~ '^[0-9a-f]{64}$' then 'passed'
            else 'failed' end candidate_gate,
       case when a.id is null then 'verified_review_receipt_required'
            when chunks.needs_review>0 or con.needs_review>0 then 'theme_candidate_review_required'
            when chunks.failed>0 or con.failed>0 then 'theme_candidate_worker_failed'
            when rr.seed_count=0 and a.status='candidates_ready' then 'passed'
            when a.status<>'candidates_ready' then 'theme_candidate_discovery_incomplete'
            when cand.n=0 then 'theme_candidates_missing'
            else 'passed' end gate_reason
from (select 1) q left join rr on true left join a on true left join chunks on true left join con on true left join cand on true;
revoke all on public.verified_theme_candidate_gate_v7 from public,anon,authenticated;
grant select on public.verified_theme_candidate_gate_v7 to service_role;
commit;
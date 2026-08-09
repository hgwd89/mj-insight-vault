begin;
create or replace view public.article_classification_quality_gate_v6
with (security_invoker=true)
as
with ocr as (
  select id,article_count,verification_set_fingerprint from public.current_verified_ocr_corpus_receipt_v5
), dg as (
  select audit_run_id,duplicate_gate,gate_reason from public.source_grounded_duplicate_gate_v6
), jobs as (
  select count(*)::integer total,
         count(*) filter(where j.status='queued')::integer queued,
         count(*) filter(where j.status='running')::integer running,
         count(*) filter(where j.status='needs_review')::integer needs_review,
         count(*) filter(where j.status='completed')::integer completed,
         count(*) filter(where j.status='failed')::integer failed
  from public.article_classification_jobs_v4 j
  join ocr on ocr.id=j.ocr_receipt_id and ocr.verification_set_fingerprint=j.ocr_verification_set_fingerprint
  join dg on dg.audit_run_id=j.duplicate_audit_run_id
  where j.classifier_version='article_category_profile_v6_verified_ocr_dual'
), profiles as (
  select count(*)::integer n,
         count(*) filter(where p.classification_status='no_matching_category')::integer no_match
  from public.article_profiles_v4 p
  join public.article_classification_jobs_v4 j on j.id=p.classification_job_id and j.status='completed'
  join ocr on ocr.id=p.ocr_receipt_id and ocr.verification_set_fingerprint=p.ocr_verification_set_fingerprint
  join dg on dg.audit_run_id=p.duplicate_audit_run_id
  where p.classifier_version='article_category_profile_v6_verified_ocr_dual'
)
select coalesce(ocr.article_count,0)::integer formal_article_count,
       coalesce(profiles.n,0)::integer profiled_article_count,
       (coalesce(profiles.n,0)-coalesce(profiles.no_match,0))::integer categorized_article_count,
       coalesce(profiles.no_match,0)::integer no_matching_category_count,
       coalesce(jobs.total,0)::integer total_jobs,coalesce(jobs.queued,0)::integer queued_jobs,coalesce(jobs.running,0)::integer running_jobs,
       coalesce(jobs.needs_review,0)::integer review_jobs,coalesce(jobs.completed,0)::integer completed_jobs,coalesce(jobs.failed,0)::integer failed_jobs,
       case when coalesce(dg.duplicate_gate,'failed')<>'passed' then 'failed'
            when coalesce(ocr.article_count,0)>0 and profiles.n=ocr.article_count and jobs.total=ocr.article_count and jobs.completed=ocr.article_count and jobs.needs_review=0 and jobs.failed=0 then 'passed'
            else 'failed' end category_classification_gate,
       case when coalesce(dg.duplicate_gate,'failed')<>'passed' then 'verified_duplicate_clearance_required'
            when coalesce(ocr.article_count,0)=0 then 'verified_ocr_receipt_required'
            when jobs.needs_review>0 then 'classification_review_required'
            when jobs.failed>0 then 'classification_jobs_failed'
            when profiles.n<>ocr.article_count or jobs.completed<>ocr.article_count then 'verified_ocr_classification_incomplete'
            else 'passed' end gate_reason
from (select 1) x
left join ocr on true
left join dg on true
left join jobs on true
left join profiles on true;
commit;
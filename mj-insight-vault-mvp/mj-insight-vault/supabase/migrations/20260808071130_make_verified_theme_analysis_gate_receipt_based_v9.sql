begin;
create or replace view public.current_verified_theme_analysis_proof_v8
with (security_invoker=true)
as
select p.*
from public.verified_theme_analysis_proof_receipts_v8 p
join public.verified_theme_census_receipts_v8 c on c.id=p.census_receipt_id and c.analysis_run_id=p.analysis_run_id and c.candidate_count=p.candidate_count
join public.verified_article_review_corpus_receipts_v7 rr on rr.id=c.review_receipt_id
join public.category_classification_corpus_receipts_v7 cr on cr.id=rr.classification_receipt_id
join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=cr.freeze_receipt_id
join public.current_verified_ocr_corpus_receipt_v5 o on o.id=cr.ocr_receipt_id and o.freeze_receipt_id=cr.freeze_receipt_id
join public.source_grounded_duplicate_gate_v6 dg on dg.duplicate_gate='passed' and dg.audit_run_id=cr.duplicate_audit_run_id
join public.verified_theme_analysis_runs_v7 a on a.id=p.analysis_run_id and a.review_receipt_id=rr.id and a.status='ranked' and a.candidate_set_fingerprint=c.candidate_set_fingerprint
where cr.category_catalog_fingerprint=public.analysis_category_catalog_fingerprint_v4()
order by p.created_at desc limit 1;

create or replace view public.verified_theme_analysis_gate_v8
with (security_invoker=true)
as
select p.id proof_receipt_id,p.analysis_run_id,p.candidate_count,p.metrics_fingerprint,p.evidence_fingerprint,'passed'::text analysis_gate,'passed'::text gate_reason from public.current_verified_theme_analysis_proof_v8 p
union all
select null::uuid,null::uuid,0::integer,null::text,null::text,'failed'::text,'verified_theme_analysis_proof_required'::text where not exists(select 1 from public.current_verified_theme_analysis_proof_v8);
commit;
create or replace view public.corpus_scan_truth_audit_v1
with (security_invoker=true)
as
with batch_base as (
  select
    b.run_id,
    b.id batch_id,
    b.batch_index,
    b.prompt_version,
    b.status,
    b.article_count,
    coalesce(b.article_ids,'{}'::uuid[]) article_ids,
    coalesce(b.evidence_article_ids,'{}'::text[]) persisted_evidence_ids,
    case when jsonb_typeof(b.summary_json->'read_article_ids')='array' then b.summary_json->'read_article_ids' else '[]'::jsonb end canonical_read_ids,
    case when jsonb_typeof(b.summary_json->'model_reported_read_article_ids')='array' then b.summary_json->'model_reported_read_article_ids' else '[]'::jsonb end model_reported_ids,
    case when jsonb_typeof(b.summary_json->'model_attested_article_ids')='array' then b.summary_json->'model_attested_article_ids' else '[]'::jsonb end model_attested_ids,
    case when jsonb_typeof(b.summary_json->'article_reviews')='array' then b.summary_json->'article_reviews' else '[]'::jsonb end article_reviews,
    case when jsonb_typeof(b.summary_json->'evidence')='array' then b.summary_json->'evidence' else '[]'::jsonb end evidence
  from public.full_corpus_scan_batches b
), batch_metrics as (
  select
    x.*,
    cardinality(x.article_ids) expected_ids,
    jsonb_array_length(x.canonical_read_ids) canonical_read_count,
    jsonb_array_length(x.model_reported_ids) model_reported_count,
    jsonb_array_length(x.model_attested_ids) model_attested_count,
    jsonb_array_length(x.article_reviews) article_review_count,
    jsonb_array_length(x.evidence) actual_evidence_count,
    cardinality(x.persisted_evidence_ids) persisted_evidence_count,
    (select count(*) from jsonb_array_elements_text(x.model_reported_ids) m(v) where m.v ~* '^[0-9a-f-]{36}$' and m.v::uuid=any(x.article_ids)) valid_model_reported_count,
    (select count(*) from jsonb_array_elements_text(x.model_reported_ids) m(v) where m.v !~* '^[0-9a-f-]{36}$' or not (m.v::uuid=any(x.article_ids))) invalid_model_reported_count,
    (select count(*) from jsonb_array_elements_text(x.model_attested_ids) m(v) where m.v ~* '^[0-9a-f-]{36}$' and m.v::uuid=any(x.article_ids)) valid_model_attested_count,
    (select count(*) from unnest(x.persisted_evidence_ids) eid where not exists(
      select 1 from jsonb_array_elements(x.evidence) e
      where coalesce(e->>'article_id','')=eid
    )) inflated_evidence_id_count,
    (select count(*)
     from jsonb_array_elements(x.article_reviews) r(item)
     join public.articles a on coalesce(r.item->>'article_id','') ~* '^[0-9a-f-]{36}$' and a.id=(r.item->>'article_id')::uuid
     where (r.item->>'article_id')::uuid=any(x.article_ids)
       and length(btrim(coalesce(r.item->>'coverage_anchor','')))>=6
       and position(lower(regexp_replace(btrim(coalesce(r.item->>'coverage_anchor','')),'\s+',' ','g')) in lower(regexp_replace(coalesce(a.ocr_text,''),'\s+',' ','g')))>0
    ) grounded_article_review_count
  from batch_base x
), run_metrics as (
  select
    r.id run_id,
    r.scope_type,
    r.scope_query,
    r.status run_status,
    r.active_article_count,
    r.ocr_ready_article_count,
    r.analyzed_article_count,
    r.total_batches,
    r.completed_batches,
    r.failed_batches,
    coalesce(r.needs_review_batches,0) needs_review_batches,
    coalesce(r.coverage_json->>'prompt_version','') run_prompt_version,
    count(b.*) actual_batch_rows,
    coalesce(sum(b.expected_ids),0)::bigint expected_article_assignments,
    coalesce(sum(b.canonical_read_count),0)::bigint canonical_read_rows,
    coalesce(sum(b.model_reported_count),0)::bigint model_reported_rows,
    coalesce(sum(b.valid_model_reported_count),0)::bigint valid_model_reported_rows,
    coalesce(sum(b.invalid_model_reported_count),0)::bigint invalid_model_reported_rows,
    coalesce(sum(b.model_attested_count),0)::bigint model_attested_rows,
    coalesce(sum(b.valid_model_attested_count),0)::bigint valid_model_attested_rows,
    coalesce(sum(b.article_review_count),0)::bigint article_review_rows,
    coalesce(sum(b.grounded_article_review_count),0)::bigint grounded_article_review_rows,
    coalesce(sum(b.actual_evidence_count),0)::bigint actual_evidence_rows,
    coalesce(sum(b.persisted_evidence_count),0)::bigint persisted_evidence_rows,
    coalesce(sum(b.inflated_evidence_id_count),0)::bigint inflated_evidence_id_rows,
    count(*) filter(where b.canonical_read_count<>b.expected_ids) canonical_read_mismatch_batches,
    count(*) filter(where b.valid_model_reported_count<>b.expected_ids or b.invalid_model_reported_count>0) model_reported_mismatch_batches,
    count(*) filter(where b.valid_model_attested_count<>b.expected_ids or b.model_attested_count<>b.expected_ids) model_attested_mismatch_batches,
    count(*) filter(where b.grounded_article_review_count<>b.expected_ids or b.article_review_count<>b.expected_ids) article_review_mismatch_batches,
    count(*) filter(where b.inflated_evidence_id_count>0 or b.persisted_evidence_count<>b.actual_evidence_count) evidence_mismatch_batches
  from public.full_corpus_scan_runs r
  left join batch_metrics b on b.run_id=r.id
  group by r.id
)
select
  m.*,
  coalesce(g.full_corpus_gate,'failed') current_gate,
  coalesce(g.gate_reason,'') current_gate_reason,
  coalesce(g.current_article_count,m.active_article_count) current_article_count,
  coalesce(g.current_article_count_diff,0) current_article_count_diff,
  public.full_corpus_run_integrity_v2(m.run_id) v3_article_review_integrity,
  case
    when public.full_corpus_run_integrity_v2(m.run_id) then 'verified_v3_article_reviews'
    when m.run_prompt_version='full_corpus_batch_v2' then 'legacy_v2_not_read_proven'
    else 'unverified'
  end truth_status
from run_metrics m
left join public.corpus_scan_gate_view g on g.id=m.run_id;

grant select on public.corpus_scan_truth_audit_v1 to service_role;
revoke all on public.corpus_scan_truth_audit_v1 from anon,authenticated;

create or replace view public.report_truth_audit_v1
with (security_invoker=true)
as
select
  cr.id report_id,
  cr.created_at,
  cr.source_job_id,
  cr.is_formal_report,
  cr.report_kind,
  cr.analysis_verification_status,
  cr.full_corpus_gate,
  coalesce(cr.answer_json->>'generation_path','') generation_path,
  coalesce(cr.answer_json->>'formal_gate_version','') formal_gate_version,
  coalesce(cr.answer_json#>>'{aaaa_formal_gate,status}','') aaaa_formal_status,
  coalesce(cr.answer_json#>>'{aaaa_formal_gate,reason}','') aaaa_formal_reason,
  case when coalesce(cr.answer_json->>'full_corpus_run_id',cr.answer_json#>>'{source_coverage,full_corpus_run_id}','') ~* '^[0-9a-f-]{36}$'
    then coalesce(cr.answer_json->>'full_corpus_run_id',cr.answer_json#>>'{source_coverage,full_corpus_run_id}')::uuid
    else null end run_id,
  case when jsonb_typeof(cr.answer_json->'major_trends')='array' then jsonb_array_length(cr.answer_json->'major_trends') else 0 end theme_count,
  case when jsonb_typeof(cr.answer_json->'evidence_matrix')='array' then jsonb_array_length(cr.answer_json->'evidence_matrix') else 0 end evidence_count,
  case when jsonb_typeof(cr.answer_json->'counterevidence_matrix')='array' then jsonb_array_length(cr.answer_json->'counterevidence_matrix') else 0 end counterevidence_count,
  case
    when cr.is_formal_report and public.report_aaaa_contract_v1(cr.answer_json) then 'formal_aaaa_contract_passed'
    when cr.is_formal_report then 'formal_without_current_aaaa_proof'
    when coalesce(cr.answer_json#>>'{aaaa_formal_gate,status}','')='blocked' then 'blocked_by_aaaa_contract'
    else 'non_formal'
  end truth_status
from public.chat_reports cr;

grant select on public.report_truth_audit_v1 to service_role;
revoke all on public.report_truth_audit_v1 from anon,authenticated;
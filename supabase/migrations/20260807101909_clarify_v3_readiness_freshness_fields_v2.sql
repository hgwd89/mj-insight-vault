drop view if exists public.aaaa_pipeline_readiness_v1;

create view public.aaaa_pipeline_readiness_v1
with (security_invoker=true)
as
with formal_stats as (
  select count(*)::bigint formal_article_count,
         count(*) filter(where coalesce(source_ocr_sha256,'') ~ '^[0-9a-f]{64}$')::bigint source_hash_ready_count,
         count(*) filter(where coalesce(analysis_text_sha256,'') ~ '^[0-9a-f]{64}$')::bigint analysis_hash_ready_count,
         count(*) filter(where length(coalesce(ocr_text,''))>4000)::bigint article_over_4000_count
  from public.formal_corpus_articles_v1
), embeddings as (
  select count(distinct e.article_id)::bigint embedded_formal_article_count
  from public.article_embeddings e
  join public.formal_corpus_articles_v1 f on f.id=e.article_id
), proof as (
  select * from public.formal_corpus_scope_proof_v1('all','')
), latest_any as (
  select r.id,r.status,r.active_article_count,r.analyzed_article_count,r.total_batches,r.completed_batches,
         coalesce(r.coverage_json->>'prompt_version','') prompt_version
  from public.full_corpus_scan_runs r
  where r.scope_type='all' and r.scope_query is null
  order by r.created_at desc
  limit 1
), latest_any_gate as (
  select g.full_corpus_gate,g.gate_reason,g.current_article_count,g.current_article_count_diff
  from public.corpus_scan_gate_view g
  join latest_any a on a.id=g.id
), latest_v3 as (
  select r.id,r.status,r.active_article_count,r.analyzed_article_count,r.total_batches,r.completed_batches,
         coalesce(r.coverage_json->>'prompt_version','') prompt_version
  from public.full_corpus_scan_runs r
  where r.scope_type='all' and r.scope_query is null
    and coalesce(r.coverage_json->>'prompt_version','')='full_corpus_batch_v3_article_reviews'
  order by r.created_at desc
  limit 1
), latest_v3_gate as (
  select g.full_corpus_gate,g.gate_reason,g.current_article_count,g.current_article_count_diff
  from public.corpus_scan_gate_view g
  join latest_v3 v on v.id=g.id
), category_gate as (
  select category_classification_gate,gate_reason
  from public.category_classification_gate_v1
), report_stats as (
  select count(*) filter(where is_formal_report)::bigint current_formal_report_count,
         count(*) filter(where not is_formal_report)::bigint current_nonformal_report_count
  from public.chat_reports
), jobs as (
  select count(*) filter(where status in ('queued','running') and coalesce(request_json->>'pipeline_version','') like 'report_pipeline_v3%')::bigint active_report_pipeline_jobs
  from public.chat_jobs
), cron_state as (
  select count(*) filter(where active and command='select public.kick_active_v2_corpus_scan_v1();')::bigint legacy_v2_scan_cron_active
  from cron.job
)
select fs.formal_article_count,
       p.corpus_content_fingerprint,
       fs.source_hash_ready_count,
       fs.analysis_hash_ready_count,
       e.embedded_formal_article_count,
       fs.article_over_4000_count,
       cg.category_classification_gate,
       cg.gate_reason as category_gate_reason,
       a.id as latest_all_scan_id,
       a.prompt_version as latest_all_scan_prompt_version,
       a.status as latest_all_scan_status,
       coalesce(ag.full_corpus_gate,'missing') as latest_all_full_corpus_gate,
       coalesce(ag.gate_reason,'no_scan') as latest_all_gate_reason,
       ag.current_article_count as latest_all_current_article_count,
       ag.current_article_count_diff as latest_all_current_article_count_diff,
       v.id as latest_v3_scan_id,
       v.status as latest_v3_scan_status,
       coalesce(vg.full_corpus_gate,'missing') as latest_v3_full_corpus_gate,
       coalesce(vg.gate_reason,'no_v3_scan') as latest_v3_gate_reason,
       vg.current_article_count as latest_v3_current_article_count,
       vg.current_article_count_diff as latest_v3_current_article_count_diff,
       case when v.id is null then false else public.full_corpus_run_integrity_v2(v.id) end as v3_article_review_integrity,
       rs.current_formal_report_count,
       rs.current_nonformal_report_count,
       j.active_report_pipeline_jobs,
       cs.legacy_v2_scan_cron_active,
       case
         when fs.formal_article_count=0 then 'formal_corpus_empty'
         when fs.source_hash_ready_count<>fs.formal_article_count or fs.analysis_hash_ready_count<>fs.formal_article_count then 'article_provenance_incomplete'
         when e.embedded_formal_article_count<>fs.formal_article_count then 'embedding_coverage_incomplete'
         when fs.article_over_4000_count>0 then 'v3_scan_must_remove_4000_char_truncation'
         when v.id is null then 'v3_article_review_scan_required'
         when not public.full_corpus_run_integrity_v2(v.id) then 'v3_article_review_integrity_failed'
         else 'v3_article_review_ready'
       end as readiness_status
from formal_stats fs
cross join embeddings e
cross join proof p
cross join category_gate cg
cross join report_stats rs
cross join jobs j
cross join cron_state cs
left join latest_any a on true
left join latest_any_gate ag on true
left join latest_v3 v on true
left join latest_v3_gate vg on true;

revoke all on public.aaaa_pipeline_readiness_v1 from public,anon,authenticated;
grant select on public.aaaa_pipeline_readiness_v1 to postgres,service_role;
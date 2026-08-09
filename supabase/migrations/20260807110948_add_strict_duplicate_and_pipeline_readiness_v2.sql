create or replace view public.formal_corpus_duplicate_gate_v2
with (security_invoker=true)
as
select d.exact_analysis_text_duplicate_groups,
       d.same_source_index_semantic_duplicate_pairs,
       d.near_source_page_duplicate_pairs,
       d.cross_source_same_date_duplicate_pairs,
       e.strict_embedding_count,
       e.formal_article_count,
       e.embedding_gate,
       case when e.embedding_gate<>'passed' then 'failed'
            when d.duplicate_gate<>'passed' then 'failed'
            else 'passed' end duplicate_gate,
       case when e.embedding_gate<>'passed' then 'strict_embedding_rebuild_required_before_duplicate_clearance'
            when d.duplicate_gate<>'passed' then d.gate_reason
            else 'passed' end gate_reason
from public.formal_corpus_duplicate_gate_v1 d
cross join public.article_embedding_quality_gate_v1 e;

revoke all on public.formal_corpus_duplicate_gate_v2 from public,anon,authenticated;
grant select on public.formal_corpus_duplicate_gate_v2 to postgres,service_role;

create or replace view public.aaaa_pipeline_readiness_v2
with (security_invoker=true)
as
with formal_stats as (
  select count(*)::integer formal_article_count,
         count(*) filter(where coalesce(source_ocr_sha256,'') ~ '^[0-9a-f]{64}$')::integer source_hash_ready_count,
         count(*) filter(where coalesce(analysis_text_sha256,'') ~ '^[0-9a-f]{64}$')::integer analysis_hash_ready_count,
         count(*) filter(where length(coalesce(ocr_text,''))>3600)::integer article_over_3600_count,
         count(*) filter(where length(coalesce(ocr_text,''))>4000)::integer article_over_4000_count,
         count(*) filter(where coalesce(s.ocr_text_raw,'')='')::integer missing_raw_ocr_count,
         count(distinct a.source_image_id)::integer source_page_count
  from public.formal_corpus_articles_v1 a
  left join public.source_images s on s.id=a.source_image_id
), proof as (
  select * from public.formal_corpus_scope_proof_v2('all','')
), category_gate as (
  select * from public.category_classification_gate_v2
), embedding_gate as (
  select * from public.article_embedding_quality_gate_v1
), duplicate_gate as (
  select * from public.formal_corpus_duplicate_gate_v2
), latest_v4 as (
  select r.* from public.full_corpus_scan_runs r
  where r.scope_type='all' and r.scope_query is null
    and coalesce(r.coverage_json->>'prompt_version','')='full_corpus_batch_v4_source_grounded_article_reviews'
  order by r.created_at desc limit 1
), latest_v4_gate as (
  select g.* from public.corpus_scan_gate_view g join latest_v4 v on v.id=g.id
), reports as (
  select count(*) filter(where is_formal_report)::integer formal_report_count,
         count(*) filter(where not is_formal_report)::integer provisional_report_count
  from public.chat_reports
), jobs as (
  select count(*) filter(where status in ('queued','running') and coalesce(request_json->>'pipeline_version','') like 'report_pipeline_v4%')::integer active_v4_report_jobs,
         count(*) filter(where status in ('queued','running') and coalesce(request_json->>'pipeline_version','')='report_pipeline_v3')::integer active_legacy_v3_report_jobs
  from public.chat_jobs
), rollups as (
  select count(*) filter(where integrity_ok)::integer valid_monthly_rollups,
         count(*) filter(where not integrity_ok)::integer invalid_monthly_rollups
  from public.monthly_rollup_gate_v3
), legacy_scan_cron as (
  select count(*) filter(where active and command='select public.kick_active_v2_corpus_scan_v1();')::integer active_legacy_v2_scan_cron
  from cron.job
)
select fs.*,
       p.corpus_content_fingerprint,
       cg.profiled_article_count,cg.categorized_article_count,cg.unprofiled_article_count,cg.uncategorized_article_count,
       cg.stale_profile_count,cg.stale_membership_count,cg.category_classification_gate,cg.gate_reason category_gate_reason,
       eg.any_embedding_count,eg.legacy_embedding_count,eg.page_ocr_contaminated_count,eg.strict_embedding_count,eg.embedding_gate,eg.gate_reason embedding_gate_reason,
       dg.exact_analysis_text_duplicate_groups,dg.same_source_index_semantic_duplicate_pairs,dg.near_source_page_duplicate_pairs,dg.cross_source_same_date_duplicate_pairs,dg.duplicate_gate,dg.gate_reason duplicate_gate_reason,
       v.id latest_v4_scan_id,v.status latest_v4_scan_status,vg.full_corpus_gate latest_v4_count_gate,vg.gate_reason latest_v4_count_gate_reason,
       r.formal_report_count,r.provisional_report_count,
       j.active_v4_report_jobs,j.active_legacy_v3_report_jobs,
       ro.valid_monthly_rollups,ro.invalid_monthly_rollups,
       lc.active_legacy_v2_scan_cron,
       case
         when fs.formal_article_count=0 then 'formal_corpus_empty'
         when fs.missing_raw_ocr_count>0 then 'raw_source_ocr_missing'
         when fs.source_hash_ready_count<>fs.formal_article_count or fs.analysis_hash_ready_count<>fs.formal_article_count then 'article_provenance_hash_incomplete'
         when eg.embedding_gate<>'passed' then 'strict_embedding_rebuild_required'
         when dg.duplicate_gate<>'passed' then 'strict_duplicate_clearance_required'
         when cg.category_classification_gate<>'passed' then 'full_text_category_classification_required'
         when v.id is null then 'v4_source_grounded_scan_required'
         when coalesce(vg.full_corpus_gate,'failed')<>'passed' then 'v4_source_grounded_scan_not_current'
         else 'ready_for_v4_report_proof'
       end readiness_status
from formal_stats fs
cross join proof p
cross join category_gate cg
cross join embedding_gate eg
cross join duplicate_gate dg
cross join reports r
cross join jobs j
cross join rollups ro
cross join legacy_scan_cron lc
left join latest_v4 v on true
left join latest_v4_gate vg on true;

revoke all on public.aaaa_pipeline_readiness_v2 from public,anon,authenticated;
grant select on public.aaaa_pipeline_readiness_v2 to postgres,service_role;
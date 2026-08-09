create view public.article_source_region_integrity_v4 as
with blocksets as (
  select a.article_id,a.source_image_id,count(*)::integer block_count,
         string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index) source_region_text,
         encode(digest(convert_to(string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index),'UTF8'),'sha256'),'hex') source_region_sha256,
         encode(digest(convert_to(string_agg(a.page_index::text||':'||a.block_index::text||':'||a.source_ocr_json_sha256,'|' order by a.page_index,a.block_index),'UTF8'),'sha256'),'hex') partition_fingerprint,
         max(similarity(normalize_article_headline_v1(f.headline),normalize_article_headline_v1(b.block_text))) headline_similarity
  from public.source_ocr_block_assignments_v2 a
  join public.source_ocr_blocks_v1 b using(source_image_id,page_index,block_index)
  join public.formal_corpus_articles_v1 f on f.id=a.article_id
  where a.assignment_version='source_block_partition_v3_page_identity' and a.assignment_kind='article'
  group by a.article_id,a.source_image_id
), base as (
  select f.id article_id,f.source_image_id article_capture_source_image_id,f.headline,a.analysis_body_clean_sha256,am.page_identity_source_image_id,pc.evidence_source_image_id
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  join public.source_page_capture_map_v1 am on am.source_image_id=f.source_image_id
  join public.source_page_primary_capture_v1 pc on pc.page_identity_source_image_id=am.page_identity_source_image_id
)
select b.article_id,b.article_capture_source_image_id,b.page_identity_source_image_id,b.evidence_source_image_id,
       r.id source_region_id,r.quality_status,bs.block_count,bs.source_region_text,bs.source_region_sha256,bs.partition_fingerprint,bs.headline_similarity,p.partition_gate,
       case
         when r.id is null then 'failed'
         when r.partition_job_id is null then 'failed'
         when r.region_version<>'source_region_v3_page_identity_blockset' then 'failed'
         when r.block_partition_version<>'source_block_partition_v3_page_identity' then 'failed'
         when r.source_image_id<>b.evidence_source_image_id then 'failed'
         when not exists(
           select 1 from public.source_page_partition_jobs_v3 j
           join public.formal_corpus_freeze_gate_v1 fg on fg.freeze_receipt_id=j.freeze_receipt_id and fg.freeze_gate='passed'
           where j.id=r.partition_job_id and j.status='completed'
             and j.page_identity_source_image_id=b.page_identity_source_image_id
             and j.evidence_source_image_id=b.evidence_source_image_id
         ) then 'failed'
         when p.partition_gate<>'passed' then 'failed'
         when bs.block_count is null or bs.block_count<1 then 'failed'
         when r.assigned_block_count<>bs.block_count then 'failed'
         when r.partition_fingerprint<>bs.partition_fingerprint then 'failed'
         when r.source_region_sha256<>bs.source_region_sha256 then 'failed'
         when r.source_region_text<>bs.source_region_text then 'failed'
         when r.source_clean_body_sha256<>b.analysis_body_clean_sha256 then 'failed'
         when r.source_image_raw_ocr_sha256<>(select raw_ocr_sha256 from public.source_images where id=b.evidence_source_image_id) then 'failed'
         when coalesce(bs.headline_similarity,0)>=0.20 then 'passed'
         when public.grounding_review_passes_v3(r.partition_job_id,b.article_id,b.evidence_source_image_id,bs.source_region_text,b.analysis_body_clean_sha256,(select raw_ocr_sha256 from public.source_images where id=b.evidence_source_image_id)) then 'passed'
         else 'failed'
       end integrity_gate,
       r.partition_job_id
from base b
left join public.article_source_regions r on r.article_id=b.article_id and r.region_version='source_region_v3_page_identity_blockset'
left join blocksets bs on bs.article_id=b.article_id and bs.source_image_id=b.evidence_source_image_id
left join public.source_page_block_partition_gate_v3 p on p.page_identity_source_image_id=b.page_identity_source_image_id;

create view public.article_source_region_gate_v4 as
select count(*)::integer formal_article_count,
       count(*) filter(where integrity_gate='passed')::integer source_grounded_article_count,
       count(*) filter(where integrity_gate<>'passed')::integer missing_or_invalid_source_region_count,
       count(distinct page_identity_source_image_id)::integer source_page_identity_count,
       count(distinct page_identity_source_image_id) filter(where partition_gate='passed')::integer partition_complete_page_identity_count,
       case when count(*)>0 and count(*) filter(where integrity_gate='passed')=count(*) then 'passed' else 'failed' end source_region_gate,
       case when count(*)=0 then 'no_formal_articles'
            when count(*) filter(where partition_gate<>'passed')>0 then 'source_page_partition_incomplete'
            when count(*) filter(where integrity_gate<>'passed')>0 then 'article_source_region_incomplete'
            else 'passed' end gate_reason
from public.article_source_region_integrity_v4;

create view public.aaaa_pipeline_readiness_v5 as
with fs as (select * from public.formal_corpus_freeze_snapshot_v1()),
identity_gate as (select * from public.formal_source_page_identity_gate_v1),
freeze_gate as (select * from public.formal_corpus_freeze_gate_v1),
primary_capture as (
  select count(*)::int primary_capture_count,
         count(*) filter(where headline_ge020_count<article_count)::int pages_needing_secondary_grounding,
         sum(article_count-headline_ge020_count)::int articles_needing_secondary_grounding,
         count(*) filter(where freeze_receipt_id is distinct from (select freeze_receipt_id from public.formal_corpus_freeze_gate_v1))::int stale_primary_capture_count
  from public.source_page_primary_capture_v1
),
source_region as (select * from public.article_source_region_gate_v4),
partition_jobs as (
  select count(*)::int total_partition_jobs,count(*) filter(where status='queued')::int queued_partition_jobs,count(*) filter(where status='running')::int running_partition_jobs,count(*) filter(where status='needs_review')::int review_partition_jobs,count(*) filter(where status='completed')::int completed_partition_jobs,count(*) filter(where status='failed')::int failed_partition_jobs
  from public.source_page_partition_jobs_v3
),
embedding as (select * from public.article_embedding_quality_gate_v2),
dup_gate as (select * from public.formal_corpus_duplicate_gate_v4),
category_gate as (select * from public.category_classification_gate_v3),
scans as (select count(*) filter(where scope_type='all' and scope_query is null and coalesce(coverage_json->>'prompt_version','')='full_corpus_batch_v4_source_grounded_article_reviews')::int v4_scan_run_count from public.full_corpus_scan_runs),
themes as (select count(*) filter(where status='completed')::int completed_theme_runs from public.theme_analysis_runs_v4),
reports as (select count(*) filter(where is_formal_report)::int formal_report_count from public.chat_reports)
select fs.article_count formal_article_count,fs.source_capture_count,fs.source_page_identity_count,ig.page_identity_gate,fg.freeze_gate,fg.gate_reason freeze_gate_reason,
       pc.primary_capture_count,pc.pages_needing_secondary_grounding,pc.articles_needing_secondary_grounding,pc.stale_primary_capture_count,
       sr.source_grounded_article_count,sr.missing_or_invalid_source_region_count,sr.partition_complete_page_identity_count,sr.source_region_gate,sr.gate_reason source_region_gate_reason,
       pj.total_partition_jobs,pj.queued_partition_jobs,pj.running_partition_jobs,pj.review_partition_jobs,pj.completed_partition_jobs,pj.failed_partition_jobs,
       e.strict_embedding_count,e.embedding_gate,e.gate_reason embedding_gate_reason,
       dg.duplicate_gate,dg.gate_reason duplicate_gate_reason,
       cg.categorized_article_count,cg.category_classification_gate,cg.gate_reason category_gate_reason,
       s.v4_scan_run_count,t.completed_theme_runs,r.formal_report_count,
       case
         when fs.article_count=0 then 'formal_corpus_empty'
         when ig.page_identity_gate<>'passed' then 'page_identity_gate_failed'
         when fg.freeze_gate<>'passed' then 'formal_corpus_freeze_stale'
         when pc.primary_capture_count<>fs.source_page_identity_count or pc.stale_primary_capture_count>0 then 'primary_capture_selection_stale'
         when sr.source_region_gate<>'passed' then 'source_region_v3_mapping_required'
         when e.embedding_gate<>'passed' then 'strict_clean_embedding_rebuild_required'
         when dg.duplicate_gate<>'passed' then 'strict_duplicate_audit_required'
         when cg.category_classification_gate<>'passed' then 'strict_clean_category_classification_required'
         when s.v4_scan_run_count=0 then 'v4_source_grounded_scan_required'
         when t.completed_theme_runs=0 then 'v4_theme_census_required'
         else 'ready_for_v4_report_proof'
       end readiness_status
from fs cross join identity_gate ig cross join freeze_gate fg cross join primary_capture pc cross join source_region sr cross join partition_jobs pj cross join embedding e cross join dup_gate dg cross join category_gate cg cross join scans s cross join themes t cross join reports r;
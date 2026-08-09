begin;

create or replace view public.formal_source_grounded_articles_v6
with (security_invoker=true)
as
with valid_regions as (
  select r.*,j.page_identity_source_image_id,j.evidence_source_image_id,j.freeze_receipt_id,
         es.raw_ocr_sha256 current_source_raw_ocr_sha256
  from public.article_source_regions r
  join public.source_page_partition_jobs_v3 j on j.id=r.partition_job_id
  join public.source_images es on es.id=j.evidence_source_image_id
  join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id
  where r.region_version='source_region_v6_inventory_consensus'
    and r.block_partition_version='source_block_partition_v6_inventory_consensus'
    and r.quality_status='passed'
    and j.partition_version='source_region_v6_inventory_consensus'
    and j.status='completed'
    and r.source_image_id=j.evidence_source_image_id
    and r.source_image_raw_ocr_sha256=es.raw_ocr_sha256
    and r.source_region_sha256=encode(extensions.digest(convert_to(r.source_region_text,'UTF8'),'sha256'),'hex')
    and r.assigned_block_count=(select count(*) from public.source_ocr_block_assignments_v2 a where a.source_image_id=r.source_image_id and a.page_index=r.page_index and a.assignment_version=r.block_partition_version and a.assignment_kind='article' and a.article_id=r.article_id)
    and r.partition_fingerprint=(select encode(extensions.digest(convert_to(string_agg(a.page_index::text||':'||a.block_index::text||':'||a.source_ocr_json_sha256,'|' order by a.page_index,a.block_index),'UTF8'),'sha256'),'hex') from public.source_ocr_block_assignments_v2 a where a.source_image_id=r.source_image_id and a.page_index=r.page_index and a.assignment_version=r.block_partition_version and a.assignment_kind='article' and a.article_id=r.article_id)
    and position(lower(r.headline_anchor) in lower(r.source_region_text))>0
), current_articles as (
  select v.*,f.source_image_id source_capture_image_id
  from public.formal_article_analysis_text_v2 v
  join public.formal_corpus_articles_v1 f on f.id=v.article_id
)
select
  v.article_id,v.headline,v.article_date,v.article_type,v.source_capture_image_id as source_image_id,
  r.page_identity_source_image_id,r.evidence_source_image_id,
  v.analysis_body,v.analysis_body_sha256,v.analysis_body_chars,
  r.id source_region_id,r.partition_job_id,r.region_version,r.page_index,r.x_min,r.y_min,r.x_max,r.y_max,
  r.mapping_method,r.mapping_confidence,r.headline_anchor,r.headline_similarity,r.source_region_text,r.source_region_sha256,
  r.source_image_raw_ocr_sha256,r.current_source_raw_ocr_sha256,r.source_clean_body_sha256,r.block_partition_version,
  r.assigned_block_count,r.partition_fingerprint,r.quality_status,r.quality_reason,'passed'::text integrity_gate
from current_articles v
join valid_regions r on r.article_id=v.article_id
join public.source_page_capture_map_v1 cm on cm.source_image_id=v.source_capture_image_id and cm.page_identity_source_image_id=r.page_identity_source_image_id
where r.source_clean_body_sha256=v.analysis_body_sha256
  and coalesce(r.source_region_text,'')<>''
  and r.mapping_confidence>=0.80;

revoke all on public.formal_source_grounded_articles_v6 from public,anon,authenticated;
grant select on public.formal_source_grounded_articles_v6 to service_role;

create or replace view public.source_region_inventory_gate_v6
with (security_invoker=true)
as
with expected as (
  select count(*)::integer article_count,count(distinct m.page_identity_source_image_id)::integer page_count
  from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id
), actual as (
  select count(*)::integer article_count,count(distinct page_identity_source_image_id)::integer page_count from public.formal_source_grounded_articles_v6
), jobs as (
  select count(*)::integer job_count,count(*) filter(where status='completed')::integer completed_jobs
  from public.source_page_partition_jobs_v3 j
  join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id
  where j.partition_version='source_region_v6_inventory_consensus'
)
select expected.article_count expected_article_count,actual.article_count source_grounded_article_count,
       expected.page_count expected_page_count,actual.page_count source_grounded_page_count,
       jobs.job_count,jobs.completed_jobs,
       case when actual.article_count=expected.article_count and actual.page_count=expected.page_count and jobs.job_count=expected.page_count and jobs.completed_jobs=expected.page_count then 'passed' else 'failed' end source_region_gate,
       case when actual.article_count<>expected.article_count then 'article_region_count_mismatch'
            when actual.page_count<>expected.page_count then 'page_region_count_mismatch'
            when jobs.job_count<>expected.page_count or jobs.completed_jobs<>expected.page_count then 'inventory_materialization_jobs_incomplete'
            else null end source_region_gate_reason
from expected cross join actual cross join jobs;

revoke all on public.source_region_inventory_gate_v6 from public,anon,authenticated;
grant select on public.source_region_inventory_gate_v6 to service_role;

create or replace view public.article_region_ocr_quality_v1
with (security_invoker=true)
as
with region_blocks as (
  select r.id source_region_id,r.article_id,r.partition_job_id,r.source_image_id,r.source_region_sha256,
         q.symbol_count,q.avg_symbol_confidence,q.symbols_lt_080,q.symbols_lt_060,
         q.digit_symbol_count,q.avg_digit_confidence,q.digits_lt_080,q.digits_lt_060,q.quality_status block_quality_status
  from public.article_source_regions r
  join public.source_ocr_block_assignments_v2 a on a.source_image_id=r.source_image_id and a.article_id=r.article_id and a.assignment_kind='article' and a.assignment_version=r.block_partition_version
  join public.source_ocr_block_quality_v2 q on q.source_image_id=a.source_image_id and q.page_index=a.page_index and q.block_index=a.block_index
  where r.region_version='source_region_v6_inventory_consensus' and r.quality_status='passed'
), agg as (
  select source_region_id,article_id,partition_job_id,source_image_id,source_region_sha256,
         count(*)::integer block_count,sum(symbol_count)::integer symbol_count,
         sum(avg_symbol_confidence*symbol_count)/nullif(sum(symbol_count),0) avg_symbol_confidence,
         sum(symbols_lt_080)::integer symbols_lt_080,sum(symbols_lt_060)::integer symbols_lt_060,
         sum(digit_symbol_count)::integer digit_symbol_count,
         sum(coalesce(avg_digit_confidence,0)*digit_symbol_count)/nullif(sum(digit_symbol_count),0) avg_digit_confidence,
         sum(digits_lt_080)::integer digits_lt_080,sum(digits_lt_060)::integer digits_lt_060,
         count(*) filter(where block_quality_status='low')::integer low_block_count,
         count(*) filter(where block_quality_status='review')::integer review_block_count,
         count(*) filter(where block_quality_status='strong')::integer strong_block_count
  from region_blocks group by source_region_id,article_id,partition_job_id,source_image_id,source_region_sha256
)
select *,
  round(100.0*symbols_lt_080/nullif(symbol_count,0),3) symbols_lt_080_pct,
  round(100.0*symbols_lt_060/nullif(symbol_count,0),3) symbols_lt_060_pct,
  round(100.0*digits_lt_080/nullif(digit_symbol_count,0),3) digits_lt_080_pct,
  case when symbol_count<20 then 'invalid'
       when avg_symbol_confidence>=0.92 and symbols_lt_080::numeric/greatest(symbol_count,1)<=0.15 and low_block_count=0 and (digit_symbol_count=0 or (avg_digit_confidence>=0.90 and digits_lt_080::numeric/greatest(digit_symbol_count,1)<=0.20)) then 'strong'
       when avg_symbol_confidence>=0.85 and symbols_lt_080::numeric/greatest(symbol_count,1)<=0.30 and (digit_symbol_count=0 or (avg_digit_confidence>=0.80 and digits_lt_080::numeric/greatest(digit_symbol_count,1)<=0.40)) then 'review'
       else 'low' end region_quality_status
from agg;

revoke all on public.article_region_ocr_quality_v1 from public,anon,authenticated;
grant select on public.article_region_ocr_quality_v1 to service_role;

create or replace view public.aaaa_ocr_readiness_v1
with (security_invoker=true)
as
select
  (select count(*) from public.formal_corpus_articles_v1) formal_article_count,
  (select count(*) from public.formal_source_grounded_articles_v6) source_grounded_count,
  (select count(*) from public.article_region_ocr_quality_v1 where region_quality_status='strong') strong_region_count,
  (select count(*) from public.article_region_ocr_quality_v1 where region_quality_status='review') review_region_count,
  (select count(*) from public.article_region_ocr_quality_v1 where region_quality_status in ('low','invalid')) low_region_count,
  (select count(*) from public.article_ocr_verifications_v1 v join public.formal_source_grounded_articles_v6 g on g.article_id=v.article_id and g.source_region_id=v.source_region_id and g.partition_job_id=v.partition_job_id where v.quality_status='passed') verified_article_count,
  case when (select source_region_gate from public.source_region_inventory_gate_v6)<>'passed' then 'source_region_required'
       when (select count(*) from public.article_ocr_verifications_v1 v join public.formal_source_grounded_articles_v6 g on g.article_id=v.article_id and g.source_region_id=v.source_region_id and g.partition_job_id=v.partition_job_id where v.quality_status='passed')<>(select count(*) from public.formal_corpus_articles_v1) then 'article_ocr_verification_required'
       else 'passed' end ocr_readiness_gate;

revoke all on public.aaaa_ocr_readiness_v1 from public,anon,authenticated;
grant select on public.aaaa_ocr_readiness_v1 to service_role;

create or replace view public.formal_source_grounded_articles_v5
with (security_invoker=true)
as
select g.*,
       v.verification_version,v.region_quality_status,v.verification_mode,
       v.canonical_text verified_canonical_text,v.canonical_text_sha256 verified_canonical_text_sha256,
       v.numeric_verification_status,v.proper_noun_verification_status,
       v.independent_provider,v.independent_model,v.independent_response_id,v.independent_prompt_sha256,v.independent_response_sha256,
       v.verified_at ocr_verified_at,
       ip.ingest_mode,ip.original_available,ip.quality_status ingest_quality_status
from public.formal_source_grounded_articles_v6 g
join public.article_ocr_verifications_v1 v on v.article_id=g.article_id and v.source_region_id=g.source_region_id and v.partition_job_id=g.partition_job_id and v.source_region_sha256=g.source_region_sha256 and v.source_ocr_sha256=g.current_source_raw_ocr_sha256
join public.source_image_ingest_provenance_v2 ip on ip.source_image_id=g.evidence_source_image_id
where v.quality_status='passed'
  and coalesce(v.canonical_text,'')<>''
  and v.numeric_verification_status in ('passed','not_applicable')
  and v.proper_noun_verification_status in ('passed','not_applicable')
  and v.canonical_text_sha256=encode(extensions.digest(convert_to(v.canonical_text,'UTF8'),'sha256'),'hex')
  and ip.quality_status not in ('needs_review','failed')
  and (ip.ingest_mode<>'legacy_reencoded_derivative' or v.verification_mode in ('crop_ocr_consensus','independent_vision_consensus','manual_verified'));

commit;
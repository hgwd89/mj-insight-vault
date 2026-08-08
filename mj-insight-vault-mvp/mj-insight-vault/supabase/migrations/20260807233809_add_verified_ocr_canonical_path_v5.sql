grant select on public.article_ocr_verifications_v1 to service_role;
grant select on public.source_page_article_inventory_jobs_v1,public.source_page_article_inventory_pass_runs_v1,public.source_page_article_inventory_groups_v1 to service_role;
revoke insert,update,delete,truncate,references,trigger on public.source_ocr_block_quality_v2 from service_role;
grant select on public.source_ocr_block_quality_v2 to service_role;

create or replace view public.source_ocr_quality_gate_v2
with (security_invoker=true)
as
with e as (select count(*)::integer n from public.source_ocr_blocks_v1), q as (
 select count(*)::integer n,
        count(*) filter(where not exists(select 1 from public.source_ocr_blocks_v1 b where b.source_image_id=x.source_image_id and b.page_index=x.page_index and b.block_index=x.block_index and b.source_ocr_json_sha256=x.source_ocr_json_sha256))::integer stale
 from public.source_ocr_block_quality_v2 x
), missing as (
 select count(*)::integer n from public.source_ocr_blocks_v1 b where not exists(select 1 from public.source_ocr_block_quality_v2 q where q.source_image_id=b.source_image_id and q.page_index=b.page_index and q.block_index=b.block_index and q.source_ocr_json_sha256=b.source_ocr_json_sha256)
)
select e.n expected_block_count,q.n quality_block_count,missing.n missing_quality_count,q.stale stale_quality_count,
       case when e.n>0 and q.n=e.n and missing.n=0 and q.stale=0 then 'passed' else 'failed' end as ocr_quality_gate
from e cross join q cross join missing;
revoke all on public.source_ocr_quality_gate_v2 from public,anon,authenticated;
grant select on public.source_ocr_quality_gate_v2 to service_role;

create or replace view public.formal_source_grounded_articles_v5
with (security_invoker=true)
as
select g.*,
       v.verification_version,v.region_quality_status,v.verification_mode,
       v.canonical_text as verified_canonical_text,v.canonical_text_sha256 as verified_canonical_text_sha256,
       v.numeric_verification_status,v.proper_noun_verification_status,
       v.independent_provider,v.independent_model,v.independent_response_id,v.independent_prompt_sha256,v.independent_response_sha256,
       v.verified_at as ocr_verified_at
from public.formal_source_grounded_articles_v4 g
join public.article_ocr_verifications_v1 v
  on v.article_id=g.article_id
 and v.source_region_id=g.source_region_id
 and v.partition_job_id=g.partition_job_id
 and v.source_region_sha256=g.source_region_sha256
 and v.source_ocr_sha256=g.current_source_raw_ocr_sha256
where v.quality_status='passed'
  and coalesce(v.canonical_text,'')<>''
  and v.numeric_verification_status in ('passed','not_applicable')
  and v.proper_noun_verification_status in ('passed','not_applicable')
  and v.canonical_text_sha256=encode(extensions.digest(convert_to(v.canonical_text,'UTF8'),'sha256'),'hex');
revoke all on public.formal_source_grounded_articles_v5 from public,anon,authenticated;
grant select on public.formal_source_grounded_articles_v5 to service_role;

create or replace view public.formal_verified_article_text_v5
with (security_invoker=true)
as
select article_id,headline,article_date,article_type,page_identity_source_image_id,evidence_source_image_id,
       source_region_id,partition_job_id,source_region_sha256,current_source_raw_ocr_sha256,
       verified_canonical_text as analysis_text,verified_canonical_text_sha256 as analysis_text_sha256,
       verification_mode,region_quality_status,numeric_verification_status,proper_noun_verification_status
from public.formal_source_grounded_articles_v5;
revoke all on public.formal_verified_article_text_v5 from public,anon,authenticated;
grant select on public.formal_verified_article_text_v5 to service_role;

create or replace view public.formal_article_embedding_input_v5
with (security_invoker=true)
as
select v.article_id,v.source_region_id,v.partition_job_id,v.page_identity_source_image_id,v.evidence_source_image_id,
       v.source_region_sha256,v.current_source_raw_ocr_sha256,fg.freeze_receipt_id,
       v.analysis_text as embedding_input_text,v.analysis_text_sha256 as embedding_input_sha256
from public.formal_verified_article_text_v5 v
join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed';
revoke all on public.formal_article_embedding_input_v5 from public,anon,authenticated;
grant select on public.formal_article_embedding_input_v5 to service_role;

create or replace view public.formal_article_classification_input_v5
with (security_invoker=true)
as
select v.article_id,v.source_region_id,v.partition_job_id,v.source_region_sha256,v.current_source_raw_ocr_sha256,fg.freeze_receipt_id,
       public.analysis_category_catalog_fingerprint_v4() as category_catalog_fingerprint,
       v.analysis_text as verified_article_text,
       encode(extensions.digest(convert_to(jsonb_build_object('article_id',v.article_id,'source_region_sha256',v.source_region_sha256,'verified_text_sha256',v.analysis_text_sha256,'category_catalog',public.analysis_category_catalog_fingerprint_v4())::text,'UTF8'),'sha256'),'hex') as classification_input_sha256
from public.formal_verified_article_text_v5 v
join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed';
revoke all on public.formal_article_classification_input_v5 from public,anon,authenticated;
grant select on public.formal_article_classification_input_v5 to service_role;

revoke execute on function public.enqueue_article_embedding_jobs_v4() from service_role;
revoke execute on function public.claim_article_embedding_jobs_v4(integer,integer) from service_role;
revoke execute on function public.complete_article_embedding_job_v4(uuid,uuid,text,text) from service_role;
revoke execute on function public.enqueue_article_classification_jobs_v4() from service_role;
revoke execute on function public.claim_article_classification_jobs_v4(integer,integer) from service_role;
revoke execute on function public.complete_article_classification_job_v4(uuid,uuid,text,text,jsonb,jsonb) from service_role;

alter table public.article_source_regions
  add column partition_job_id uuid references public.source_page_partition_jobs_v3(id);

create function public.grounding_review_passes_v3(
  p_job_id uuid,
  p_article_id uuid,
  p_evidence_source_image_id uuid,
  p_region_text text,
  p_article_clean_body_sha256 text,
  p_source_ocr_sha256 text
)
returns boolean language sql stable security definer set search_path=public,extensions as $$
select exists(
  select 1
  from public.article_source_grounding_reviews_v3 r
  join public.source_page_partition_jobs_v3 j on j.id=r.partition_job_id
  where r.partition_job_id=p_job_id
    and r.article_id=p_article_id
    and r.evidence_source_image_id=p_evidence_source_image_id
    and r.freeze_receipt_id=j.freeze_receipt_id
    and r.article_clean_body_sha256=p_article_clean_body_sha256
    and r.source_ocr_sha256=p_source_ocr_sha256
    and r.region_sha256=encode(digest(convert_to(coalesce(p_region_text,''),'UTF8'),'sha256'),'hex')
    and r.review_version='source_grounding_v3'
    and r.mapper_decision='passed'
    and r.critic_decision='passed'
    and r.grounding_decision='passed'
    and coalesce(array_length(r.shared_terms,1),0)>=3
    and (select count(distinct t.term) from unnest(r.shared_terms) t(term))>=3
    and (select count(*) from unnest(r.shared_terms) t(term) where position(t.term in coalesce(p_region_text,''))>0)>=3
    and (select coalesce(sum(char_length(t.term)),0) from (select distinct term from unnest(r.shared_terms) term) t where position(t.term in coalesce(p_region_text,''))>0)>=12
);
$$;
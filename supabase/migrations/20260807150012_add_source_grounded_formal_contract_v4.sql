alter table public.article_embeddings
  add column if not exists source_region_id uuid references public.article_source_regions(id),
  add column if not exists source_region_sha256 text,
  add column if not exists source_partition_job_id uuid references public.source_page_partition_jobs_v3(id),
  add column if not exists freeze_receipt_id uuid references public.formal_corpus_freeze_receipts_v1(id),
  add column if not exists embedding_model text;

alter table public.article_profiles
  add column if not exists source_region_id uuid references public.article_source_regions(id),
  add column if not exists source_region_sha256 text,
  add column if not exists source_partition_job_id uuid references public.source_page_partition_jobs_v3(id),
  add column if not exists freeze_receipt_id uuid references public.formal_corpus_freeze_receipts_v1(id);

alter table public.article_category_memberships
  add column if not exists source_region_id uuid references public.article_source_regions(id),
  add column if not exists source_region_sha256 text,
  add column if not exists source_partition_job_id uuid references public.source_page_partition_jobs_v3(id),
  add column if not exists freeze_receipt_id uuid references public.formal_corpus_freeze_receipts_v1(id);

create view public.formal_source_grounded_articles_v4 as
select v.article_id,
       v.headline,
       v.article_date,
       v.article_type,
       v.source_image_id,
       i.page_identity_source_image_id,
       i.evidence_source_image_id,
       v.analysis_body,
       v.analysis_body_sha256,
       v.analysis_body_chars,
       r.id as source_region_id,
       r.partition_job_id,
       r.region_version,
       r.page_index,
       r.x_min,r.y_min,r.x_max,r.y_max,
       r.mapping_method,r.mapping_confidence,
       r.headline_anchor,r.headline_similarity,
       r.source_region_text,r.source_region_sha256,
       r.source_image_raw_ocr_sha256,
       es.raw_ocr_sha256 as current_source_raw_ocr_sha256,
       r.source_clean_body_sha256,
       r.block_partition_version,
       r.assigned_block_count,
       r.partition_fingerprint,
       r.quality_status,r.quality_reason,
       i.integrity_gate
from public.formal_article_analysis_text_v2 v
join public.article_source_region_integrity_v4 i on i.article_id=v.article_id and i.integrity_gate='passed'
join public.article_source_regions r on r.id=i.source_region_id and r.partition_job_id=i.partition_job_id
join public.source_images es on es.id=i.evidence_source_image_id
join public.formal_corpus_freeze_gate_v1 fg on fg.freeze_gate='passed'
where r.region_version='source_region_v3_page_identity_blockset'
  and r.quality_status='passed'
  and r.source_clean_body_sha256=v.analysis_body_sha256
  and r.source_image_raw_ocr_sha256=es.raw_ocr_sha256
  and coalesce(r.source_region_text,'')<>''
  and coalesce(r.source_region_sha256,'') ~ '^[0-9a-f]{64}$';

create view public.formal_category_memberships_v4 as
select m.article_id,m.category_id,m.score,m.confidence,m.source,m.match_terms,m.reason,m.created_at,m.updated_at,
       m.source_clean_body_sha256,m.source_region_id,m.source_region_sha256,m.source_partition_job_id,m.freeze_receipt_id
from public.article_category_memberships m
join public.formal_source_grounded_articles_v4 g on g.article_id=m.article_id
join public.analysis_categories c on c.id=m.category_id and c.is_active=true
join public.formal_corpus_freeze_gate_v1 fg on fg.freeze_gate='passed' and fg.freeze_receipt_id=m.freeze_receipt_id
where m.source='article_category_profile_v4_source_grounded'
  and m.source_clean_body_sha256=g.analysis_body_sha256
  and m.source_region_id=g.source_region_id
  and m.source_region_sha256=g.source_region_sha256
  and m.source_partition_job_id=g.partition_job_id;

create function public.formal_corpus_scope_proof_v4(p_scope_type text default 'all',p_scope_query text default '')
returns table(article_count bigint,source_truth_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with scoped as (
  select distinct f.id article_id,
         f.source_image_id,
         m.page_identity_source_image_id,
         coalesce(f.headline,'') headline,
         a.article_date_normalized,
         a.analysis_body_clean_sha256,
         s.raw_ocr_sha256
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  join public.source_images s on s.id=f.source_image_id
  join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
  where p_scope_type='all'
     or (p_scope_type='category' and coalesce(p_scope_query,'')<>'' and exists(
          select 1 from public.formal_category_memberships_v4 cm where cm.article_id=f.id and cm.category_id=p_scope_query
        ))
), c as (
  select count(*)::bigint n,
         coalesce(string_agg(
           encode(extensions.digest(convert_to(jsonb_build_array(
             article_id::text,source_image_id::text,page_identity_source_image_id::text,headline,
             coalesce(article_date_normalized::text,''),coalesce(analysis_body_clean_sha256,''),coalesce(raw_ocr_sha256,'')
           )::text,'UTF8'),'sha256'),'hex'),
           '|' order by article_id::text
         ),'') payload
  from scoped
)
select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex')
from c where p_scope_type in ('all','category');
$$;

create function public.formal_source_grounded_scope_proof_v4(p_scope_type text default 'all',p_scope_query text default '')
returns table(article_count bigint,source_grounded_fingerprint text)
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with scoped as (
  select distinct g.article_id,g.source_image_id,g.page_identity_source_image_id,g.evidence_source_image_id,
         g.source_region_id,g.partition_job_id,g.analysis_body_sha256,g.source_region_sha256,g.current_source_raw_ocr_sha256
  from public.formal_source_grounded_articles_v4 g
  where p_scope_type='all'
     or (p_scope_type='category' and coalesce(p_scope_query,'')<>'' and exists(
          select 1 from public.formal_category_memberships_v4 cm where cm.article_id=g.article_id and cm.category_id=p_scope_query
        ))
), c as (
  select count(*)::bigint n,
         coalesce(string_agg(
           encode(extensions.digest(convert_to(jsonb_build_array(
             article_id::text,source_image_id::text,page_identity_source_image_id::text,evidence_source_image_id::text,
             source_region_id::text,partition_job_id::text,analysis_body_sha256,source_region_sha256,current_source_raw_ocr_sha256
           )::text,'UTF8'),'sha256'),'hex'),
           '|' order by article_id::text
         ),'') payload
  from scoped
)
select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex')
from c where p_scope_type in ('all','category');
$$;

revoke all on table public.formal_source_grounded_articles_v4 from anon,authenticated;
revoke all on table public.formal_category_memberships_v4 from anon,authenticated;
grant select on table public.formal_source_grounded_articles_v4 to service_role;
grant select on table public.formal_category_memberships_v4 to service_role;
revoke execute on function public.formal_corpus_scope_proof_v4(text,text) from public,anon,authenticated;
revoke execute on function public.formal_source_grounded_scope_proof_v4(text,text) from public,anon,authenticated;
grant execute on function public.formal_corpus_scope_proof_v4(text,text) to service_role;
grant execute on function public.formal_source_grounded_scope_proof_v4(text,text) to service_role;
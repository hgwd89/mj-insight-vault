create table if not exists public.article_duplicate_reviews_v2 (
  id uuid primary key default gen_random_uuid(),
  article_id_a uuid not null references public.articles(id) on delete cascade,
  article_id_b uuid not null references public.articles(id) on delete cascade,
  detection_version text not null default 'clean_embedding_duplicate_candidates_v2',
  disposition text not null check(disposition in ('distinct','duplicate')),
  canonical_article_id uuid references public.articles(id) on delete set null,
  reason text not null,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(article_id_a,article_id_b,detection_version),
  check(article_id_a<article_id_b),
  check(length(btrim(reason))>=8),
  check((disposition='distinct' and canonical_article_id is null) or (disposition='duplicate' and canonical_article_id in (article_id_a,article_id_b)))
);

alter table public.article_duplicate_reviews_v2 enable row level security;
revoke all on public.article_duplicate_reviews_v2 from public,anon,authenticated;
grant select,insert,update,delete on public.article_duplicate_reviews_v2 to service_role;

create or replace view public.article_duplicate_candidates_v2
with (security_invoker=true)
as
with f as (
  select a.article_id,a.headline,a.article_date,a.source_image_id,
         e.embedding_vector
  from public.formal_article_analysis_text_v2 a
  join public.formal_article_embeddings_v3 e on e.article_id=a.article_id
), exact_body as (
  select least(a.article_id,b.article_id) article_id_a,greatest(a.article_id,b.article_id) article_id_b,
         'exact_clean_body_hash' detection_reason,1.0::double precision semantic_similarity,
         similarity(a.headline,b.headline)::double precision headline_similarity
  from public.formal_article_analysis_text_v2 a
  join public.formal_article_analysis_text_v2 b on a.article_id<b.article_id and a.analysis_body_sha256=b.analysis_body_sha256
), same_source_index as (
  select a.article_id article_id_a,b.article_id article_id_b,'same_source_index_high_semantic' detection_reason,
         (1-(a.embedding_vector <=> b.embedding_vector))::double precision semantic_similarity,
         similarity(a.headline,b.headline)::double precision headline_similarity
  from f a join f b on a.article_id<b.article_id and a.source_image_id=b.source_image_id
  join public.articles aa on aa.id=a.article_id
  join public.articles bb on bb.id=b.article_id and bb.article_index=aa.article_index
  where 1-(a.embedding_vector <=> b.embedding_vector)>=0.985
), near_page as (
  select least(a.article_id,b.article_id) article_id_a,greatest(a.article_id,b.article_id) article_id_b,'near_duplicate_source_page' detection_reason,
         (1-(a.embedding_vector <=> b.embedding_vector))::double precision semantic_similarity,
         similarity(a.headline,b.headline)::double precision headline_similarity
  from public.source_image_near_duplicate_audit_v1 p
  join f a on a.source_image_id=p.source_image_id_a and a.article_date=p.article_date
  join f b on b.source_image_id=p.source_image_id_b and b.article_date=p.article_date
  where similarity(a.headline,b.headline)>=0.50 and 1-(a.embedding_vector <=> b.embedding_vector)>=0.95
), same_date as (
  select a.article_id article_id_a,b.article_id article_id_b,'same_date_high_semantic' detection_reason,
         (1-(a.embedding_vector <=> b.embedding_vector))::double precision semantic_similarity,
         similarity(a.headline,b.headline)::double precision headline_similarity
  from f a join f b on a.article_id<b.article_id and a.article_date=b.article_date and a.source_image_id<>b.source_image_id
  where (1-(a.embedding_vector <=> b.embedding_vector)>=0.995)
     or (1-(a.embedding_vector <=> b.embedding_vector)>=0.98 and similarity(a.headline,b.headline)>=0.70)
), unioned as (
  select * from exact_body union all select * from same_source_index union all select * from near_page union all select * from same_date
), collapsed as (
  select article_id_a,article_id_b,
         string_agg(distinct detection_reason,'+' order by detection_reason) detection_reason,
         max(semantic_similarity) semantic_similarity,
         max(headline_similarity) headline_similarity
  from unioned group by article_id_a,article_id_b
)
select c.*,
       r.disposition review_disposition,r.reason review_reason,r.reviewed_at
from collapsed c
left join public.article_duplicate_reviews_v2 r
  on r.article_id_a=c.article_id_a and r.article_id_b=c.article_id_b and r.detection_version='clean_embedding_duplicate_candidates_v2';

create or replace view public.formal_corpus_duplicate_gate_v3
with (security_invoker=true)
as
with e as (select * from public.article_embedding_quality_gate_v2), c as (select * from public.article_duplicate_candidates_v2)
select e.formal_article_count,e.strict_embedding_count,e.embedding_gate,
       (select count(*)::integer from c) duplicate_candidate_pair_count,
       (select count(*)::integer from c where review_disposition='distinct') reviewed_distinct_pair_count,
       (select count(*)::integer from c where review_disposition='duplicate') reviewed_duplicate_pair_count,
       (select count(*)::integer from c where review_disposition is null) unresolved_pair_count,
       case when e.embedding_gate<>'passed' then 'failed'
            when exists(select 1 from c where review_disposition is distinct from 'distinct') then 'failed'
            else 'passed' end duplicate_gate,
       case when e.embedding_gate<>'passed' then 'strict_clean_embedding_required'
            when exists(select 1 from c where review_disposition='duplicate') then 'duplicate_candidate_must_be_removed_from_formal_corpus'
            when exists(select 1 from c where review_disposition is null) then 'duplicate_candidates_require_review'
            else 'passed' end gate_reason
from e;

revoke all on public.article_duplicate_candidates_v2,public.formal_corpus_duplicate_gate_v3 from public,anon,authenticated;
grant select on public.article_duplicate_candidates_v2,public.formal_corpus_duplicate_gate_v3 to postgres,service_role;
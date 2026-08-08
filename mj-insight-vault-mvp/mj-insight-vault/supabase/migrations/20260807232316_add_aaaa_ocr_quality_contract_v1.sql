create table if not exists public.source_ocr_block_quality_v2 (
  source_image_id uuid not null references public.source_images(id) on delete cascade,
  page_index integer not null,
  block_index integer not null,
  source_ocr_json_sha256 text not null,
  symbol_count integer not null,
  avg_symbol_confidence numeric,
  p10_symbol_confidence numeric,
  symbols_lt_080 integer not null default 0,
  symbols_lt_060 integer not null default 0,
  digit_symbol_count integer not null default 0,
  avg_digit_confidence numeric,
  digits_lt_080 integer not null default 0,
  digits_lt_060 integer not null default 0,
  quality_status text not null check (quality_status in ('strong','review','low','invalid')),
  computed_at timestamptz not null default now(),
  primary key (source_image_id,page_index,block_index)
);

alter table public.source_ocr_block_quality_v2 enable row level security;
revoke all on public.source_ocr_block_quality_v2 from public, anon, authenticated;
grant select,insert,update,delete on public.source_ocr_block_quality_v2 to service_role;

create or replace function public.classify_source_ocr_block_quality_v2(
  p_symbol_count integer,
  p_avg numeric,
  p_p10 numeric,
  p_low80 integer,
  p_digit_count integer,
  p_digit_avg numeric,
  p_digit_low80 integer
) returns text
language sql immutable
set search_path = pg_catalog, public
as $$
  select case
    when coalesce(p_symbol_count,0)=0 then 'invalid'
    when p_avg >= 0.92
      and coalesce(p_p10,0) >= 0.70
      and p_low80::numeric / greatest(p_symbol_count,1) <= 0.15
      and (coalesce(p_digit_count,0)=0 or (coalesce(p_digit_avg,0) >= 0.90 and p_digit_low80::numeric/greatest(p_digit_count,1) <= 0.20))
      then 'strong'
    when p_avg >= 0.85
      and coalesce(p_p10,0) >= 0.45
      and p_low80::numeric / greatest(p_symbol_count,1) <= 0.30
      and (coalesce(p_digit_count,0)=0 or (coalesce(p_digit_avg,0) >= 0.80 and p_digit_low80::numeric/greatest(p_digit_count,1) <= 0.40))
      then 'review'
    else 'low'
  end
$$;
revoke all on function public.classify_source_ocr_block_quality_v2(integer,numeric,numeric,integer,integer,numeric,integer) from public, anon, authenticated;
grant execute on function public.classify_source_ocr_block_quality_v2(integer,numeric,numeric,integer,integer,numeric,integer) to service_role;

create table if not exists public.article_ocr_verifications_v1 (
  article_id uuid primary key references public.articles(id) on delete cascade,
  source_region_id uuid not null references public.article_source_regions(id) on delete cascade,
  partition_job_id uuid not null references public.source_page_partition_jobs_v3(id) on delete cascade,
  verification_version text not null default 'article_ocr_verification_v1',
  region_quality_status text not null check (region_quality_status in ('strong','review','low','invalid')),
  verification_mode text not null check (verification_mode in ('region_ocr_strong','crop_ocr_consensus','independent_vision_consensus','manual_verified')),
  canonical_text text not null,
  canonical_text_sha256 text not null check (canonical_text_sha256 ~ '^[0-9a-f]{64}$'),
  source_region_sha256 text not null check (source_region_sha256 ~ '^[0-9a-f]{64}$'),
  source_ocr_sha256 text not null check (source_ocr_sha256 ~ '^[0-9a-f]{64}$'),
  numeric_verification_status text not null check (numeric_verification_status in ('not_applicable','passed','needs_review','failed')),
  proper_noun_verification_status text not null check (proper_noun_verification_status in ('not_applicable','passed','needs_review','failed')),
  independent_provider text,
  independent_model text,
  independent_response_id text,
  independent_prompt_sha256 text,
  independent_response_sha256 text,
  quality_status text not null check (quality_status in ('passed','needs_review','failed')),
  quality_reason text,
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.article_ocr_verifications_v1 enable row level security;
revoke all on public.article_ocr_verifications_v1 from public, anon, authenticated, service_role;

create or replace view public.article_region_ocr_quality_v1
with (security_invoker=true)
as
with region_blocks as (
  select r.id as source_region_id,r.article_id,r.partition_job_id,r.source_image_id,r.source_region_sha256,
         q.symbol_count,q.avg_symbol_confidence,q.symbols_lt_080,q.symbols_lt_060,
         q.digit_symbol_count,q.avg_digit_confidence,q.digits_lt_080,q.digits_lt_060,q.quality_status as block_quality_status
  from public.article_source_regions r
  join public.source_ocr_block_assignments_v2 a
    on a.source_image_id=r.source_image_id and a.article_id=r.article_id and a.assignment_kind='article'
  join public.source_ocr_block_quality_v2 q
    on q.source_image_id=a.source_image_id and q.page_index=a.page_index and q.block_index=a.block_index
  where r.region_version='source_region_v3_page_identity_blockset'
), agg as (
  select source_region_id,article_id,partition_job_id,source_image_id,source_region_sha256,
         count(*)::integer as block_count,
         sum(symbol_count)::integer as symbol_count,
         sum(avg_symbol_confidence*symbol_count)/nullif(sum(symbol_count),0) as avg_symbol_confidence,
         sum(symbols_lt_080)::integer as symbols_lt_080,
         sum(symbols_lt_060)::integer as symbols_lt_060,
         sum(digit_symbol_count)::integer as digit_symbol_count,
         sum(coalesce(avg_digit_confidence,0)*digit_symbol_count)/nullif(sum(digit_symbol_count),0) as avg_digit_confidence,
         sum(digits_lt_080)::integer as digits_lt_080,
         sum(digits_lt_060)::integer as digits_lt_060,
         count(*) filter(where block_quality_status='low')::integer as low_block_count,
         count(*) filter(where block_quality_status='review')::integer as review_block_count,
         count(*) filter(where block_quality_status='strong')::integer as strong_block_count
  from region_blocks group by source_region_id,article_id,partition_job_id,source_image_id,source_region_sha256
)
select *,
  round(100.0*symbols_lt_080/nullif(symbol_count,0),3) as symbols_lt_080_pct,
  round(100.0*symbols_lt_060/nullif(symbol_count,0),3) as symbols_lt_060_pct,
  round(100.0*digits_lt_080/nullif(digit_symbol_count,0),3) as digits_lt_080_pct,
  case
    when symbol_count<20 then 'invalid'
    when avg_symbol_confidence>=0.92
      and symbols_lt_080::numeric/greatest(symbol_count,1)<=0.15
      and low_block_count=0
      and (digit_symbol_count=0 or (avg_digit_confidence>=0.90 and digits_lt_080::numeric/greatest(digit_symbol_count,1)<=0.20)) then 'strong'
    when avg_symbol_confidence>=0.85
      and symbols_lt_080::numeric/greatest(symbol_count,1)<=0.30
      and (digit_symbol_count=0 or (avg_digit_confidence>=0.80 and digits_lt_080::numeric/greatest(digit_symbol_count,1)<=0.40)) then 'review'
    else 'low'
  end as region_quality_status
from agg;

revoke all on public.article_region_ocr_quality_v1 from public, anon, authenticated;
grant select on public.article_region_ocr_quality_v1 to service_role;

create or replace view public.aaaa_ocr_readiness_v1
with (security_invoker=true)
as
select
  (select count(*) from public.formal_corpus_articles_v1) as formal_article_count,
  (select count(*) from public.formal_source_grounded_articles_v4) as source_grounded_count,
  (select count(*) from public.article_region_ocr_quality_v1 where region_quality_status='strong') as strong_region_count,
  (select count(*) from public.article_region_ocr_quality_v1 where region_quality_status='review') as review_region_count,
  (select count(*) from public.article_region_ocr_quality_v1 where region_quality_status in ('low','invalid')) as low_region_count,
  (select count(*) from public.article_ocr_verifications_v1 where quality_status='passed') as verified_article_count,
  case
    when (select count(*) from public.formal_source_grounded_articles_v4)=0 then 'source_region_required'
    when (select count(*) from public.article_ocr_verifications_v1 where quality_status='passed')<>(select count(*) from public.formal_corpus_articles_v1) then 'article_ocr_verification_required'
    else 'passed'
  end as ocr_readiness_gate;
revoke all on public.aaaa_ocr_readiness_v1 from public, anon, authenticated;
grant select on public.aaaa_ocr_readiness_v1 to service_role;
-- Diagnose recovered Inventory groups that contain blocks semantically closer to another
-- formal article headline on the same page. Diagnostic only: no block reassignment occurs here.

create or replace function public.inventory_cross_article_block_risk_v20(p_inventory_job_id uuid)
returns table(
  inventory_job_id uuid,
  block_index integer,
  assigned_article_id uuid,
  assigned_headline text,
  block_text text,
  assigned_similarity real,
  best_alt_article_id uuid,
  best_alt_headline text,
  best_alt_similarity real,
  alt_margin real,
  risk_status text
)
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with assigned as (
  select
    a.inventory_job_id,
    a.block_index,
    a.article_id as assigned_article_id,
    f.headline as assigned_headline,
    b.block_text,
    similarity(
      public.normalize_article_headline_v1(f.headline),
      public.normalize_article_headline_v1(b.block_text)
    ) as assigned_similarity
  from public.source_inventory_block_assignments_v7 a
  join public.source_page_article_inventory_blocks_v1 b
    on b.job_id=a.inventory_job_id
   and b.block_index=a.block_index
  join public.formal_corpus_articles_v1 f on f.id=a.article_id
  where a.inventory_job_id=p_inventory_job_id
    and a.assignment_kind='article'
    and a.assignment_version='source_block_partition_v7_recovered_inventory'
), candidate as (
  select
    x.*,
    m.article_id as alt_article_id,
    f2.headline as alt_headline,
    similarity(
      public.normalize_article_headline_v1(f2.headline),
      public.normalize_article_headline_v1(x.block_text)
    ) as alt_similarity,
    row_number() over(
      partition by x.inventory_job_id,x.block_index
      order by similarity(
        public.normalize_article_headline_v1(f2.headline),
        public.normalize_article_headline_v1(x.block_text)
      ) desc, m.article_id::text
    ) as rn
  from assigned x
  join public.source_page_article_inventory_mappings_v2 m
    on m.job_id=x.inventory_job_id
   and m.article_id<>x.assigned_article_id
  join public.formal_corpus_articles_v1 f2 on f2.id=m.article_id
), best as (
  select * from candidate where rn=1
)
select
  inventory_job_id,
  block_index,
  assigned_article_id,
  assigned_headline,
  block_text,
  assigned_similarity,
  alt_article_id as best_alt_article_id,
  alt_headline as best_alt_headline,
  alt_similarity as best_alt_similarity,
  (alt_similarity-assigned_similarity)::real as alt_margin,
  case
    when alt_similarity>=0.35 and alt_similarity>=assigned_similarity+0.15
      then 'likely_misassigned'
    when assigned_similarity>=0.20 and alt_similarity>=0.20 and abs(alt_similarity-assigned_similarity)<0.12
      then 'mixed_or_ambiguous'
    else 'none'
  end as risk_status
from best
order by block_index
$function$;

revoke all on function public.inventory_cross_article_block_risk_v20(uuid) from public,anon,authenticated;
grant execute on function public.inventory_cross_article_block_risk_v20(uuid) to postgres,service_role;

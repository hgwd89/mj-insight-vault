create or replace view public.source_capture_ocr_quality_v2
with (security_invoker=true)
as
select q.source_image_id,
       sum(q.symbol_count)::bigint as symbol_count,
       sum(q.avg_symbol_confidence*q.symbol_count)/nullif(sum(q.symbol_count),0) as weighted_symbol_confidence,
       sum(q.symbols_lt_080)::numeric/nullif(sum(q.symbol_count),0) as low80_share,
       sum(q.symbols_lt_060)::numeric/nullif(sum(q.symbol_count),0) as low60_share,
       sum(q.digit_symbol_count)::bigint as digit_symbol_count,
       sum(coalesce(q.avg_digit_confidence,0)*q.digit_symbol_count)/nullif(sum(q.digit_symbol_count),0) as weighted_digit_confidence,
       sum(q.digits_lt_080)::numeric/nullif(sum(q.digit_symbol_count),0) as digit_low80_share
from public.source_ocr_block_quality_v2 q
group by q.source_image_id;
revoke all on public.source_capture_ocr_quality_v2 from public,anon,authenticated;
grant select on public.source_capture_ocr_quality_v2 to service_role;

create or replace view public.source_page_inventory_capture_v1
with (security_invoker=true)
as
with ranked as (
  select m.page_identity_source_image_id,m.source_image_id,
         q.weighted_symbol_confidence,q.low80_share,q.low60_share,q.weighted_digit_confidence,q.digit_low80_share,
         b.source_ocr_json_sha256,
         count(b.*)::integer as block_count,
         row_number() over(partition by m.page_identity_source_image_id
                           order by q.weighted_symbol_confidence desc nulls last,q.low80_share asc nulls last,q.low60_share asc nulls last,m.source_image_id) as rn
  from public.source_page_capture_map_v1 m
  join public.source_capture_ocr_quality_v2 q on q.source_image_id=m.source_image_id
  join public.source_ocr_blocks_v1 b on b.source_image_id=m.source_image_id
  group by m.page_identity_source_image_id,m.source_image_id,q.weighted_symbol_confidence,q.low80_share,q.low60_share,q.weighted_digit_confidence,q.digit_low80_share,b.source_ocr_json_sha256
), article_counts as (
  select m.page_identity_source_image_id,count(*)::integer as existing_article_count
  from public.formal_corpus_articles_v1 a
  join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id
  group by m.page_identity_source_image_id
)
select r.page_identity_source_image_id,r.source_image_id as inventory_source_image_id,r.source_ocr_json_sha256,r.block_count,
       r.weighted_symbol_confidence,r.low80_share,r.low60_share,r.weighted_digit_confidence,r.digit_low80_share,
       ac.existing_article_count,
       (ac.existing_article_count>=6 or coalesce(r.weighted_symbol_confidence,0)<0.88 or coalesce(r.low80_share,1)>0.18) as requires_third_pass
from ranked r join article_counts ac using(page_identity_source_image_id)
where r.rn=1;
revoke all on public.source_page_inventory_capture_v1 from public,anon,authenticated;
grant select on public.source_page_inventory_capture_v1 to service_role;

create table public.source_page_article_inventory_jobs_v1(
  id uuid primary key default gen_random_uuid(),
  page_identity_source_image_id uuid not null references public.source_images(id) on delete cascade,
  inventory_source_image_id uuid not null references public.source_images(id) on delete cascade,
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id) on delete cascade,
  source_ocr_json_sha256 text not null check(source_ocr_json_sha256 ~ '^[0-9a-f]{64}$'),
  block_count integer not null check(block_count>0),
  existing_article_count integer not null check(existing_article_count>=0),
  page_article_set_fingerprint text not null check(page_article_set_fingerprint ~ '^[0-9a-f]{64}$'),
  requires_third_pass boolean not null default false,
  inventory_version text not null default 'page_article_inventory_v1_unbounded',
  status text not null default 'queued' check(status in ('queued','running','needs_review','discovery_required','completed','failed')),
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(page_identity_source_image_id,freeze_receipt_id,inventory_version)
);
create table public.source_page_article_inventory_pass_runs_v1(
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.source_page_article_inventory_jobs_v1(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic','adjudicator')),
  model text not null,
  provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(job_id,pass_kind)
);
create table public.source_page_article_inventory_groups_v1(
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.source_page_article_inventory_jobs_v1(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic','adjudicator')),
  group_kind text not null check(group_kind in ('article','non_article')),
  group_fingerprint text not null check(group_fingerprint ~ '^[0-9a-f]{64}$'),
  block_indices integer[] not null,
  mapped_article_id uuid references public.articles(id),
  headline_anchor text,
  non_article_role text,
  confidence numeric not null check(confidence between 0 and 1),
  reason text,
  created_at timestamptz not null default now(),
  unique(job_id,pass_kind,group_fingerprint),
  check((group_kind='article' and coalesce(btrim(headline_anchor),'')<>'' and non_article_role is null)
     or (group_kind='non_article' and mapped_article_id is null and headline_anchor is null and coalesce(btrim(non_article_role),'')<>''))
);
alter table public.source_page_article_inventory_jobs_v1 enable row level security;
alter table public.source_page_article_inventory_pass_runs_v1 enable row level security;
alter table public.source_page_article_inventory_groups_v1 enable row level security;
revoke all on public.source_page_article_inventory_jobs_v1,public.source_page_article_inventory_pass_runs_v1,public.source_page_article_inventory_groups_v1 from public,anon,authenticated,service_role;

create or replace function public.inventory_page_article_set_proof_v1(p_page_identity_source_image_id uuid)
returns table(article_count integer,article_set_fingerprint text)
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
  with x as (
    select distinct a.id,a.analysis_text_sha256,a.article_date,a.headline
    from public.formal_corpus_articles_v1 a
    join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id
    where m.page_identity_source_image_id=p_page_identity_source_image_id
  )
  select count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(id::text||':'||coalesce(analysis_text_sha256,'')||':'||coalesce(article_date,'')||':'||coalesce(headline,''),'|' order by id::text),''),'UTF8'),'sha256'),'hex')
  from x
$$;
revoke all on function public.inventory_page_article_set_proof_v1(uuid) from public,anon,authenticated;
grant execute on function public.inventory_page_article_set_proof_v1(uuid) to service_role;
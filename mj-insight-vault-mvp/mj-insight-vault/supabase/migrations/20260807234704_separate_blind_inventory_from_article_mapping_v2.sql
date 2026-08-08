create table public.source_page_article_inventory_mappings_v2(
  job_id uuid not null references public.source_page_article_inventory_jobs_v1(id) on delete cascade,
  group_fingerprint text not null,
  article_id uuid not null references public.articles(id),
  mapping_method text not null check(mapping_method in ('auto_reciprocal_headline','dual_review')),
  mapping_score numeric,
  mapping_margin numeric,
  created_at timestamptz not null default now(),
  primary key(job_id,group_fingerprint),
  unique(job_id,article_id)
);
create table public.source_page_article_inventory_mapping_pass_runs_v2(
  id uuid primary key default gen_random_uuid(),job_id uuid not null references public.source_page_article_inventory_jobs_v1(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic')),model text not null,provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),created_at timestamptz not null default now(),unique(job_id,pass_kind)
);
create table public.source_page_article_inventory_mapping_stage_v2(
  job_id uuid not null references public.source_page_article_inventory_jobs_v1(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic')),
  group_fingerprint text not null,
  article_id uuid not null references public.articles(id),
  confidence numeric not null check(confidence between 0 and 1),
  rationale text,
  primary key(job_id,pass_kind,group_fingerprint),
  unique(job_id,pass_kind,article_id)
);
alter table public.source_page_article_inventory_mappings_v2 enable row level security;
alter table public.source_page_article_inventory_mapping_pass_runs_v2 enable row level security;
alter table public.source_page_article_inventory_mapping_stage_v2 enable row level security;
revoke all on public.source_page_article_inventory_mappings_v2,public.source_page_article_inventory_mapping_pass_runs_v2,public.source_page_article_inventory_mapping_stage_v2 from public,anon,authenticated,service_role;
grant select on public.source_page_article_inventory_mappings_v2,public.source_page_article_inventory_mapping_pass_runs_v2,public.source_page_article_inventory_mapping_stage_v2 to service_role;

create or replace view public.source_page_article_inventory_consensus_groups_v2
with (security_invoker=true)
as
select m.job_id,m.group_fingerprint,m.block_indices,m.headline_anchor,m.confidence,
       string_agg(b.block_text,E'\n---\n' order by b.x_min,b.y_min,b.block_index) as group_text
from public.source_page_article_inventory_groups_v1 m
join public.source_page_article_inventory_groups_v1 c on c.job_id=m.job_id and c.pass_kind='critic' and c.group_kind='article' and c.group_fingerprint=m.group_fingerprint
join public.source_page_article_inventory_jobs_v1 j on j.id=m.job_id
join public.source_ocr_blocks_v1 b on b.source_image_id=j.inventory_source_image_id and b.page_index=0 and b.block_index=any(m.block_indices)
where m.pass_kind='mapper' and m.group_kind='article'
group by m.job_id,m.group_fingerprint,m.block_indices,m.headline_anchor,m.confidence;
revoke all on public.source_page_article_inventory_consensus_groups_v2 from public,anon,authenticated;
grant select on public.source_page_article_inventory_consensus_groups_v2 to service_role;

create or replace function public.inventory_mapping_candidates_v2(p_job_id uuid)
returns table(group_fingerprint text,article_id uuid,score numeric,group_rank bigint,article_rank bigint,group_margin numeric)
language sql stable security definer
set search_path=pg_catalog,public,extensions
as $$
with j as (select * from public.source_page_article_inventory_jobs_v1 where id=p_job_id), arts as (
 select a.id,a.headline from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id join j on j.page_identity_source_image_id=m.page_identity_source_image_id
), scores as (
 select g.group_fingerprint,a.id article_id,
        greatest(similarity(lower(coalesce(a.headline,'')),lower(coalesce(g.headline_anchor,''))),similarity(lower(coalesce(a.headline,'')),lower(left(coalesce(g.group_text,''),240))))::numeric as score
 from public.source_page_article_inventory_consensus_groups_v2 g join arts a on true where g.job_id=p_job_id
), ranked as (
 select *,row_number() over(partition by group_fingerprint order by score desc,article_id) group_rank,
          row_number() over(partition by article_id order by score desc,group_fingerprint) article_rank,
          score-lead(score) over(partition by group_fingerprint order by score desc,article_id) group_margin
 from scores
)
select group_fingerprint,article_id,score,group_rank,article_rank,coalesce(group_margin,score) from ranked;
$$;
revoke all on function public.inventory_mapping_candidates_v2(uuid) from public,anon,authenticated;
grant execute on function public.inventory_mapping_candidates_v2(uuid) to service_role;

create or replace function public.resolve_inventory_mapping_auto_v2(p_job_id uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.source_page_article_inventory_jobs_v1%rowtype;v_groups integer;v_resolved integer;begin
 select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;if not found then raise exception 'inventory_mapping_v2_job_missing';end if;
 delete from public.source_page_article_inventory_mappings_v2 where job_id=j.id and mapping_method='auto_reciprocal_headline';
 select count(*)::integer into v_groups from public.source_page_article_inventory_consensus_groups_v2 where job_id=j.id;
 insert into public.source_page_article_inventory_mappings_v2(job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin)
 select j.id,c.group_fingerprint,c.article_id,'auto_reciprocal_headline',c.score,c.group_margin
 from public.inventory_mapping_candidates_v2(j.id) c
 where c.group_rank=1 and c.article_rank=1 and c.score>=0.18 and c.group_margin>=0.03
 on conflict(job_id,group_fingerprint) do nothing;
 get diagnostics v_resolved=row_count;
 return jsonb_build_object('group_count',v_groups,'auto_resolved',v_resolved,'unresolved',v_groups-(select count(*) from public.source_page_article_inventory_mappings_v2 where job_id=j.id));
end
$$;
revoke all on function public.resolve_inventory_mapping_auto_v2(uuid) from public,anon,authenticated;
grant execute on function public.resolve_inventory_mapping_auto_v2(uuid) to service_role;

-- Preserve duplicate rows for audit, but exclude them from every active analysis path.
-- Canonical selection is deterministic: longest reconstructed text, then enriched row,
-- then oldest ingestion timestamp and UUID.

create or replace function public.normalize_article_headline_v1(value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select lower(regexp_replace(coalesce(value, ''), '[^[:alnum:]ぁ-んァ-ヶ一-龠々ー]+', '', 'g'));
$$;

alter table public.articles
  add column if not exists duplicate_of_article_id uuid,
  add column if not exists exclusion_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'articles_duplicate_of_article_id_fkey'
      and conrelid = 'public.articles'::regclass
  ) then
    alter table public.articles
      add constraint articles_duplicate_of_article_id_fkey
      foreign key (duplicate_of_article_id)
      references public.articles(id)
      on delete set null;
  end if;
end $$;

create index if not exists articles_duplicate_of_article_id_idx
  on public.articles(duplicate_of_article_id)
  where duplicate_of_article_id is not null;

with candidates as (
  select
    a.id,
    a.article_date,
    public.normalize_article_headline_v1(a.headline) as normalized_headline,
    length(coalesce(a.ocr_text, '')) as text_length,
    exists(select 1 from public.article_profiles p where p.article_id = a.id) as has_profile,
    exists(select 1 from public.article_embeddings e where e.article_id = a.id) as has_embedding,
    a.created_at
  from public.articles a
  where (a.status is null or a.status not in ('deleted', 'excluded', 'rejected'))
    and coalesce(a.article_type, '') = 'article'
    and coalesce(btrim(a.article_date), '') <> ''
    and public.normalize_article_headline_v1(a.headline) <> ''
), ranked as (
  select
    c.*,
    first_value(c.id) over (
      partition by c.article_date, c.normalized_headline
      order by c.text_length desc, c.has_profile desc, c.has_embedding desc, c.created_at asc, c.id asc
    ) as canonical_id,
    row_number() over (
      partition by c.article_date, c.normalized_headline
      order by c.text_length desc, c.has_profile desc, c.has_embedding desc, c.created_at asc, c.id asc
    ) as duplicate_rank,
    count(*) over (partition by c.article_date, c.normalized_headline) as group_size
  from candidates c
), duplicates as (
  select id, canonical_id
  from ranked
  where group_size > 1 and duplicate_rank > 1
)
update public.articles a
set status = 'excluded',
    duplicate_of_article_id = d.canonical_id,
    exclusion_reason = 'duplicate_same_date_normalized_headline',
    updated_at = now()
from duplicates d
where a.id = d.id;

-- Derived search/classification rows for hidden records are invalid and can be regenerated.
delete from public.article_embeddings e
using public.articles a
where e.article_id = a.id
  and a.status in ('deleted', 'excluded', 'rejected');

delete from public.article_profiles p
using public.articles a
where p.article_id = a.id
  and a.status in ('deleted', 'excluded', 'rejected');

delete from public.article_category_memberships m
using public.articles a
where m.article_id = a.id
  and a.status in ('deleted', 'excluded', 'rejected');

delete from public.article_tags t
using public.articles a
where t.article_id = a.id
  and a.status in ('deleted', 'excluded', 'rejected');

create or replace function public.cleanup_hidden_article_derivatives()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('deleted', 'excluded', 'rejected')
    and coalesce(old.status, '') not in ('deleted', 'excluded', 'rejected') then
    delete from public.article_embeddings where article_id = new.id;
    delete from public.article_profiles where article_id = new.id;
    delete from public.article_category_memberships where article_id = new.id;
    delete from public.article_tags where article_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cleanup_hidden_article_derivatives on public.articles;
create trigger trg_cleanup_hidden_article_derivatives
after update of status on public.articles
for each row execute function public.cleanup_hidden_article_derivatives();

-- Enforce the same identity rule used by ingestion. Reprocessing works because old
-- rows are hidden before replacements are inserted.
create unique index if not exists articles_active_date_normalized_headline_uidx
  on public.articles(article_date, public.normalize_article_headline_v1(headline))
  where (status is null or status not in ('deleted', 'excluded', 'rejected'))
    and article_type = 'article'
    and article_date is not null
    and public.normalize_article_headline_v1(headline) <> '';

create or replace view public.article_duplicate_audit_v1
with (security_invoker = true)
as
select
  duplicate.id as duplicate_article_id,
  duplicate.duplicate_of_article_id as canonical_article_id,
  duplicate.article_date,
  duplicate.headline as duplicate_headline,
  canonical.headline as canonical_headline,
  duplicate.source_image_id as duplicate_source_image_id,
  canonical.source_image_id as canonical_source_image_id,
  duplicate.created_at as duplicate_created_at,
  canonical.created_at as canonical_created_at,
  length(coalesce(duplicate.ocr_text, '')) as duplicate_text_length,
  length(coalesce(canonical.ocr_text, '')) as canonical_text_length,
  duplicate.exclusion_reason
from public.articles duplicate
join public.articles canonical on canonical.id = duplicate.duplicate_of_article_id
where duplicate.status = 'excluded'
  and duplicate.exclusion_reason = 'duplicate_same_date_normalized_headline';

revoke all on public.article_duplicate_audit_v1 from public, anon, authenticated;
grant select on public.article_duplicate_audit_v1 to postgres, service_role;
revoke all on function public.normalize_article_headline_v1(text) from public, anon, authenticated;
revoke all on function public.cleanup_hidden_article_derivatives() from public, anon, authenticated;
grant execute on function public.normalize_article_headline_v1(text) to postgres, service_role;
grant execute on function public.cleanup_hidden_article_derivatives() to postgres, service_role;

-- Mark affected rollups stale; formal reports already require a fresh v2 scan.
update public.monthly_rollups r
set status = 'stale',
    error_message = null,
    updated_at = now()
where r.month_key in (
  select distinct substring(a.article_date from 1 for 7)
  from public.articles a
  where a.status = 'excluded'
    and a.exclusion_reason = 'duplicate_same_date_normalized_headline'
    and a.article_date ~ '^\d{4}-\d{2}'
)
  and r.status <> 'running';

-- Low-risk advisor fixes.
create index if not exists analyses_article_id_idx on public.analyses(article_id);
create index if not exists analysis_categories_parent_id_idx on public.analysis_categories(parent_id) where parent_id is not null;
drop index if exists public.idx_article_category_memberships_category;
drop index if exists public.idx_full_corpus_scan_batches_run_status;

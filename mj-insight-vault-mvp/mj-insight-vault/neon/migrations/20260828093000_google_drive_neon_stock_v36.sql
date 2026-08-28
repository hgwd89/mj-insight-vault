-- Google Drive + Neon canonical stock mode v36.
-- New originals live in Google Drive. Neon stores searchable structured metadata.
-- Supabase remains legacy/frozen and is not required by this schema.

create extension if not exists pgcrypto;

create table if not exists public.vault_runtime_config (
  config_key text primary key,
  config_value text not null,
  updated_at timestamptz not null default now()
);

insert into public.vault_runtime_config (config_key, config_value) values
  ('google_drive_root_folder_id', '1Hlw9gAuNo6eOpg6bKivBilEgR-oB4tfM'),
  ('google_drive_originals_folder_id', '1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ'),
  ('google_drive_exports_folder_id', '1FZNZaPO9MTC147yNzinSY_bGvyFTUfnG'),
  ('storage_mode', 'google_drive_neon'),
  ('new_ingest_db', 'neon'),
  ('supabase_mode', 'legacy_frozen')
on conflict (config_key) do update
set config_value = excluded.config_value,
    updated_at = now();

create table if not exists public.vault_source_files (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text not null unique,
  drive_folder_id text not null,
  file_name text not null,
  mime_type text,
  file_size_bytes bigint,
  article_date date,
  memo text,
  source_status text not null default 'stored',
  ocr_status text not null default 'not_started',
  user_id text default auth.user_id() not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vault_articles (
  id uuid primary key default gen_random_uuid(),
  source_file_id uuid not null references public.vault_source_files(id) on delete cascade,
  article_sequence integer not null,
  title text,
  ocr_text_raw text,
  ocr_text_verified text,
  verification_version text,
  verification_status text not null default 'pending',
  confidence numeric,
  user_id text default auth.user_id() not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_file_id, article_sequence)
);

create table if not exists public.vault_report_evidence (
  id uuid primary key default gen_random_uuid(),
  report_key text not null,
  article_id uuid not null references public.vault_articles(id) on delete restrict,
  user_id text default auth.user_id() not null,
  created_at timestamptz not null default now(),
  unique(report_key, article_id)
);

create index if not exists vault_source_files_created_at_idx on public.vault_source_files (created_at desc);
create index if not exists vault_source_files_article_date_idx on public.vault_source_files (article_date desc);
create index if not exists vault_source_files_user_created_idx on public.vault_source_files (user_id, created_at desc);
create index if not exists vault_articles_source_file_idx on public.vault_articles (source_file_id, article_sequence);
create index if not exists vault_articles_user_source_idx on public.vault_articles (user_id, source_file_id, article_sequence);
create index if not exists vault_articles_search_idx on public.vault_articles using gin (
  to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(ocr_text_verified, ocr_text_raw, ''))
);
create index if not exists vault_report_evidence_user_report_idx on public.vault_report_evidence (user_id, report_key);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.vault_source_files, public.vault_articles, public.vault_report_evidence to authenticated;

alter table public.vault_source_files enable row level security;
alter table public.vault_articles enable row level security;
alter table public.vault_report_evidence enable row level security;

drop policy if exists vault_source_files_user_owns on public.vault_source_files;
create policy vault_source_files_user_owns on public.vault_source_files
  for all to authenticated
  using ((select auth.user_id()) = user_id)
  with check ((select auth.user_id()) = user_id);

drop policy if exists vault_articles_user_owns on public.vault_articles;
create policy vault_articles_user_owns on public.vault_articles
  for all to authenticated
  using ((select auth.user_id()) = user_id)
  with check ((select auth.user_id()) = user_id);

drop policy if exists vault_report_evidence_user_owns on public.vault_report_evidence;
create policy vault_report_evidence_user_owns on public.vault_report_evidence
  for all to authenticated
  using ((select auth.user_id()) = user_id)
  with check ((select auth.user_id()) = user_id);

create or replace function public.vault_search_v1(p_query text default '', p_limit integer default 100)
returns table (
  source_file_id uuid,
  drive_file_id text,
  drive_folder_id text,
  file_name text,
  mime_type text,
  file_size_bytes bigint,
  article_date date,
  memo text,
  source_status text,
  ocr_status text,
  created_at timestamptz,
  matched_article_id uuid,
  matched_article_title text,
  matched_text_preview text
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as term,
           greatest(1, least(coalesce(p_limit, 100), 500)) as lim
  ), matches as (
    select
      sf.id as source_file_id,
      sf.drive_file_id,
      sf.drive_folder_id,
      sf.file_name,
      sf.mime_type,
      sf.file_size_bytes,
      sf.article_date,
      sf.memo,
      sf.source_status,
      sf.ocr_status,
      sf.created_at,
      a.id as matched_article_id,
      a.title as matched_article_title,
      left(coalesce(a.ocr_text_verified, a.ocr_text_raw, ''), 500) as matched_text_preview,
      row_number() over (
        partition by sf.id
        order by case when a.id is null then 1 else 0 end, a.article_sequence nulls last
      ) as rn
    from public.vault_source_files sf
    left join public.vault_articles a on a.source_file_id = sf.id
    cross join q
    where q.term is null
       or sf.file_name ilike '%' || q.term || '%'
       or coalesce(sf.memo, '') ilike '%' || q.term || '%'
       or coalesce(a.title, '') ilike '%' || q.term || '%'
       or coalesce(a.ocr_text_verified, a.ocr_text_raw, '') ilike '%' || q.term || '%'
  )
  select
    source_file_id, drive_file_id, drive_folder_id, file_name, mime_type,
    file_size_bytes, article_date, memo, source_status, ocr_status, created_at,
    matched_article_id, matched_article_title, matched_text_preview
  from matches, q
  where rn = 1
  order by created_at desc
  limit (select lim from q);
$$;

grant execute on function public.vault_search_v1(text, integer) to authenticated;

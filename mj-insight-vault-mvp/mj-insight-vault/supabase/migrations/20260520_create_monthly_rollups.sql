create table if not exists public.monthly_rollups (
  id uuid primary key default gen_random_uuid(),
  month_key text not null unique,
  article_count integer not null default 0,
  article_ids uuid[] not null default '{}',
  source_latest_article_at timestamptz,
  rollup_model text not null default '',
  status text not null default 'ready',
  summary_text text not null default '',
  summary_json jsonb not null default '{}'::jsonb,
  representative_article_ids uuid[] not null default '{}',
  evidence_article_ids uuid[] not null default '{}',
  error_message text,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists monthly_rollups_month_key_idx on public.monthly_rollups (month_key desc);
create index if not exists monthly_rollups_status_idx on public.monthly_rollups (status);

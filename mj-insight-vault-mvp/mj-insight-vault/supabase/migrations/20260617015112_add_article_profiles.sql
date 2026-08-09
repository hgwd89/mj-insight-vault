create table if not exists public.article_profiles (
  article_id uuid primary key references public.articles(id) on delete cascade,
  profile_model text not null default 'rule_based_v1',
  primary_category text,
  secondary_categories text[] not null default '{}',
  consumer_scene text,
  market_signal text,
  product_type text,
  consumer_need text,
  confidence numeric,
  reason text,
  profile_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_article_profiles_primary_category on public.article_profiles(primary_category);
create index if not exists idx_article_profiles_secondary_categories on public.article_profiles using gin(secondary_categories);
create index if not exists idx_article_profiles_profile_json on public.article_profiles using gin(profile_json);
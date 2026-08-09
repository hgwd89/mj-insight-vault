begin;

create table public.verified_theme_census_batches_v7(
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  batch_index integer not null check(batch_index>0),
  article_ids uuid[] not null,article_count integer not null check(article_count>0),
  candidate_set_fingerprint text not null check(candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),
  article_batch_fingerprint text not null check(article_batch_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  active_pass_kind text check(active_pass_kind is null or active_pass_kind in ('mapper','critic')),
  failure_count integer not null default 0 check(failure_count>=0),lease_token uuid,lease_expires_at timestamptz,error_message text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz,
  unique(analysis_run_id,batch_index),unique(analysis_run_id,article_batch_fingerprint)
);
create table public.verified_theme_census_passes_v7(
  batch_id uuid not null references public.verified_theme_census_batches_v7(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic')),
  model text not null,provider_response_id text not null unique,prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  result_json jsonb not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(batch_id,pass_kind)
);
create table public.verified_theme_census_article_outcomes_v7(
  analysis_run_id uuid not null references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  batch_id uuid not null references public.verified_theme_census_batches_v7(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  candidate_set_fingerprint text not null check(candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),
  matched_candidate_ids uuid[] not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  primary key(analysis_run_id,article_id),unique(batch_id,article_id)
);
create table public.verified_theme_census_relations_v7(
  analysis_run_id uuid not null references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  batch_id uuid not null references public.verified_theme_census_batches_v7(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  candidate_id uuid not null references public.verified_theme_candidates_v7(id) on delete cascade,
  mapping_confidence numeric not null check(mapping_confidence between 0 and 1),
  mapper_source_anchor text not null,critic_source_anchor text not null,mapper_reason text not null,critic_reason text not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  primary key(analysis_run_id,article_id,candidate_id)
);

alter table public.verified_theme_census_batches_v7 enable row level security;
alter table public.verified_theme_census_passes_v7 enable row level security;
alter table public.verified_theme_census_article_outcomes_v7 enable row level security;
alter table public.verified_theme_census_relations_v7 enable row level security;
revoke all on public.verified_theme_census_batches_v7,public.verified_theme_census_passes_v7,public.verified_theme_census_article_outcomes_v7,public.verified_theme_census_relations_v7 from public,anon,authenticated,service_role;
grant select on public.verified_theme_census_batches_v7,public.verified_theme_census_passes_v7,public.verified_theme_census_article_outcomes_v7,public.verified_theme_census_relations_v7 to service_role;
create index verified_theme_census_batches_v7_status_idx on public.verified_theme_census_batches_v7(status,created_at);
create index verified_theme_census_relations_v7_candidate_idx on public.verified_theme_census_relations_v7(analysis_run_id,candidate_id);
create index verified_theme_census_relations_v7_article_idx on public.verified_theme_census_relations_v7(article_id);

commit;
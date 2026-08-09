begin;

create table public.verified_theme_analysis_runs_v7(
  id uuid primary key default gen_random_uuid(),
  review_receipt_id uuid not null unique references public.verified_article_review_corpus_receipts_v7(id) on delete cascade,
  seed_count integer not null check(seed_count>0),
  review_set_fingerprint text not null check(review_set_fingerprint ~ '^[0-9a-f]{64}$'),
  seed_set_fingerprint text not null check(seed_set_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'discovering' check(status in ('discovering','consolidating','candidates_ready','census','ranked','needs_review','failed')),
  candidate_set_fingerprint text,
  error_message text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.verified_theme_seed_chunk_jobs_v7(
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  chunk_index integer not null check(chunk_index>0),
  seed_ids uuid[] not null,
  seed_count integer not null check(seed_count>0),
  seed_chunk_fingerprint text not null check(seed_chunk_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  active_pass_kind text check(active_pass_kind is null or active_pass_kind in ('synthesizer','critic')),
  failure_count integer not null default 0 check(failure_count>=0),
  lease_token uuid,lease_expires_at timestamptz,error_message text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz,
  unique(analysis_run_id,chunk_index),unique(analysis_run_id,seed_chunk_fingerprint)
);
create table public.verified_theme_seed_chunk_passes_v7(
  job_id uuid not null references public.verified_theme_seed_chunk_jobs_v7(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('synthesizer','critic')),
  model text not null,provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  result_json jsonb not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  primary key(job_id,pass_kind)
);
create table public.verified_theme_candidate_proposals_v7(
  id uuid primary key default gen_random_uuid(),
  chunk_job_id uuid not null references public.verified_theme_seed_chunk_jobs_v7(id) on delete cascade,
  proposal_key text not null,
  title text not null,definition text not null,scope_boundary text not null,
  subject text not null,measurement text not null,support_seed_ids uuid[] not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(chunk_job_id,proposal_key)
);
create table public.verified_theme_consolidation_jobs_v7(
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null unique references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  proposal_count integer not null check(proposal_count>0),
  proposal_set_fingerprint text not null check(proposal_set_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  active_pass_kind text check(active_pass_kind is null or active_pass_kind in ('consolidator','critic')),
  failure_count integer not null default 0 check(failure_count>=0),
  lease_token uuid,lease_expires_at timestamptz,error_message text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz
);
create table public.verified_theme_consolidation_passes_v7(
  job_id uuid not null references public.verified_theme_consolidation_jobs_v7(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('consolidator','critic')),
  model text not null,provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  result_json jsonb not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,pass_kind)
);
create table public.verified_theme_candidates_v7(
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  theme_key text not null,title text not null,definition text not null,inclusion_rule text not null,exclusion_rule text not null,
  subject text not null,measurement text not null,source_proposal_ids uuid[] not null,support_seed_ids uuid[] not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(analysis_run_id,theme_key)
);

alter table public.verified_theme_analysis_runs_v7 enable row level security;
alter table public.verified_theme_seed_chunk_jobs_v7 enable row level security;
alter table public.verified_theme_seed_chunk_passes_v7 enable row level security;
alter table public.verified_theme_candidate_proposals_v7 enable row level security;
alter table public.verified_theme_consolidation_jobs_v7 enable row level security;
alter table public.verified_theme_consolidation_passes_v7 enable row level security;
alter table public.verified_theme_candidates_v7 enable row level security;
revoke all on public.verified_theme_analysis_runs_v7,public.verified_theme_seed_chunk_jobs_v7,public.verified_theme_seed_chunk_passes_v7,public.verified_theme_candidate_proposals_v7,public.verified_theme_consolidation_jobs_v7,public.verified_theme_consolidation_passes_v7,public.verified_theme_candidates_v7 from public,anon,authenticated,service_role;
grant select on public.verified_theme_analysis_runs_v7,public.verified_theme_seed_chunk_jobs_v7,public.verified_theme_seed_chunk_passes_v7,public.verified_theme_candidate_proposals_v7,public.verified_theme_consolidation_jobs_v7,public.verified_theme_consolidation_passes_v7,public.verified_theme_candidates_v7 to service_role;
create index verified_theme_seed_chunk_jobs_v7_status_idx on public.verified_theme_seed_chunk_jobs_v7(status,created_at);
create index verified_theme_candidate_proposals_v7_chunk_idx on public.verified_theme_candidate_proposals_v7(chunk_job_id);
create index verified_theme_candidates_v7_run_idx on public.verified_theme_candidates_v7(analysis_run_id);

commit;
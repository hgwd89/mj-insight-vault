begin;

create table public.verified_theme_report_runs_v8(
  id uuid primary key default gen_random_uuid(),
  analysis_proof_receipt_id uuid not null unique references public.verified_theme_analysis_proof_receipts_v8(id) on delete cascade,
  analysis_run_id uuid not null references public.verified_theme_analysis_runs_v7(id) on delete cascade,
  candidate_count integer not null check(candidate_count>=0),
  status text not null default 'notes' check(status in ('notes','finalizing','completed','needs_review','failed')),
  error_message text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz
);
create table public.verified_theme_report_note_jobs_v8(
  id uuid primary key default gen_random_uuid(),run_id uuid not null references public.verified_theme_report_runs_v8(id) on delete cascade,
  candidate_id uuid not null references public.verified_theme_candidates_v7(id) on delete cascade,
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  active_pass_kind text check(active_pass_kind is null or active_pass_kind in ('generator','critic')),
  failure_count integer not null default 0 check(failure_count>=0),lease_token uuid,lease_expires_at timestamptz,error_message text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz,unique(run_id,candidate_id)
);
create table public.verified_theme_report_note_passes_v8(
  job_id uuid not null references public.verified_theme_report_note_jobs_v8(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('generator','critic')),model text not null,provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),result_json jsonb not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,pass_kind)
);
create table public.verified_theme_report_notes_v8(
  id uuid primary key default gen_random_uuid(),run_id uuid not null references public.verified_theme_report_runs_v8(id) on delete cascade,
  candidate_id uuid not null references public.verified_theme_candidates_v7(id) on delete cascade,
  interpretation text not null,trajectory_interpretation text not null,limitation text not null,evidence_article_ids uuid[] not null default '{}',
  generator_model text not null,critic_model text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(run_id,candidate_id)
);
create table public.verified_theme_report_final_jobs_v8(
  id uuid primary key default gen_random_uuid(),run_id uuid not null unique references public.verified_theme_report_runs_v8(id) on delete cascade,
  note_set_fingerprint text not null check(note_set_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  active_pass_kind text check(active_pass_kind is null or active_pass_kind in ('generator','critic')),
  failure_count integer not null default 0 check(failure_count>=0),lease_token uuid,lease_expires_at timestamptz,error_message text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz
);
create table public.verified_theme_report_final_passes_v8(
  job_id uuid not null references public.verified_theme_report_final_jobs_v8(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('generator','critic')),model text not null,provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),result_json jsonb not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(job_id,pass_kind)
);
create table public.verified_theme_reports_v8(
  id uuid primary key default gen_random_uuid(),run_id uuid not null unique references public.verified_theme_report_runs_v8(id) on delete cascade,
  analysis_proof_receipt_id uuid not null references public.verified_theme_analysis_proof_receipts_v8(id) on delete cascade,
  executive_summary text not null,cross_theme_observations jsonb not null,major_theme_ids uuid[] not null default '{}',methodology_note text not null,
  theme_metrics_json jsonb not null,theme_notes_json jsonb not null,report_fingerprint text not null check(report_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);

alter table public.verified_theme_report_runs_v8 enable row level security;
alter table public.verified_theme_report_note_jobs_v8 enable row level security;
alter table public.verified_theme_report_note_passes_v8 enable row level security;
alter table public.verified_theme_report_notes_v8 enable row level security;
alter table public.verified_theme_report_final_jobs_v8 enable row level security;
alter table public.verified_theme_report_final_passes_v8 enable row level security;
alter table public.verified_theme_reports_v8 enable row level security;
revoke all on public.verified_theme_report_runs_v8,public.verified_theme_report_note_jobs_v8,public.verified_theme_report_note_passes_v8,public.verified_theme_report_notes_v8,public.verified_theme_report_final_jobs_v8,public.verified_theme_report_final_passes_v8,public.verified_theme_reports_v8 from public,anon,authenticated,service_role;
grant select on public.verified_theme_report_runs_v8,public.verified_theme_report_note_jobs_v8,public.verified_theme_report_note_passes_v8,public.verified_theme_report_notes_v8,public.verified_theme_report_final_jobs_v8,public.verified_theme_report_final_passes_v8,public.verified_theme_reports_v8 to service_role;
create index verified_theme_report_note_jobs_v8_status_idx on public.verified_theme_report_note_jobs_v8(status,created_at);

commit;
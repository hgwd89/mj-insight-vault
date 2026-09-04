-- Neon-native durable report runtime.
-- Mirrors the production schema required by the Google Drive + Neon canonical report path.

create table if not exists public.vault_reports (
  id uuid primary key default gen_random_uuid(),
  user_query text not null,
  answer_text text,
  answer_json jsonb not null default '{}'::jsonb,
  related_article_ids uuid[] not null default '{}',
  report_kind text not null default 'neon_native',
  is_formal_report boolean not null default false,
  analysis_verification_status text not null default 'neon_native_unverified',
  hidden boolean not null default false,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id text not null default auth.user_id()
);

create table if not exists public.vault_report_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued',
  progress integer not null default 0,
  stage text not null default 'queued',
  user_query text not null,
  request_json jsonb not null default '{}'::jsonb,
  result_json jsonb,
  report_id uuid references public.vault_reports(id),
  error_message text,
  attempt_count integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz not null default now(),
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id text not null default auth.user_id()
);

create index if not exists vault_reports_created_at_idx on public.vault_reports (created_at desc);
create index if not exists vault_report_jobs_status_idx on public.vault_report_jobs (status, created_at desc);

alter table public.vault_reports alter column user_id set default auth.user_id();
alter table public.vault_report_jobs alter column user_id set default auth.user_id();

grant select, insert, update, delete on table public.vault_reports to authenticated;
grant select, insert, update, delete on table public.vault_report_jobs to authenticated;

alter table public.vault_reports enable row level security;
alter table public.vault_report_jobs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vault_reports' and policyname = 'vault_reports_user_owns'
  ) then
    create policy vault_reports_user_owns on public.vault_reports
      for all to authenticated
      using ((select auth.user_id()) = user_id)
      with check ((select auth.user_id()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vault_report_jobs' and policyname = 'vault_report_jobs_user_owns'
  ) then
    create policy vault_report_jobs_user_owns on public.vault_report_jobs
      for all to authenticated
      using ((select auth.user_id()) = user_id)
      with check ((select auth.user_id()) = user_id);
  end if;
end $$;

notify pgrst, 'reload schema';

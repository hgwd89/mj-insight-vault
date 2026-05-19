create table if not exists public.chat_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  stage text not null default '',
  user_query text not null default '',
  request_json jsonb not null default '{}'::jsonb,
  result_json jsonb,
  report_id uuid,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_jobs_created_at_idx on public.chat_jobs (created_at desc);
create index if not exists chat_jobs_status_idx on public.chat_jobs (status);
create index if not exists chat_jobs_report_id_idx on public.chat_jobs (report_id);

create or replace function public.set_chat_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_chat_jobs_updated_at on public.chat_jobs;
create trigger set_chat_jobs_updated_at
before update on public.chat_jobs
for each row
execute function public.set_chat_jobs_updated_at();

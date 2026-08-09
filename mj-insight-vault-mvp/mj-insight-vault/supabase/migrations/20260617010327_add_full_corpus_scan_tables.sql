create extension if not exists pgcrypto;

create table if not exists public.full_corpus_scan_runs (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null default 'all',
  scope_query text,
  status text not null default 'queued',
  model text not null default 'gpt-4o-mini',
  batch_size integer not null default 30,
  active_article_count integer not null default 0,
  ocr_ready_article_count integer not null default 0,
  total_batches integer not null default 0,
  completed_batches integer not null default 0,
  failed_batches integer not null default 0,
  analyzed_article_count integer not null default 0,
  coverage_json jsonb not null default '{}'::jsonb,
  synthesis_json jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.full_corpus_scan_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.full_corpus_scan_runs(id) on delete cascade,
  batch_index integer not null,
  article_ids uuid[] not null default '{}',
  article_count integer not null default 0,
  status text not null default 'queued',
  model text not null default 'gpt-4o-mini',
  prompt_version text not null default 'full_corpus_batch_v1',
  summary_json jsonb,
  evidence_article_ids uuid[] not null default '{}',
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, batch_index)
);

create index if not exists idx_full_corpus_scan_runs_status on public.full_corpus_scan_runs(status, created_at desc);
create index if not exists idx_full_corpus_scan_batches_run_status on public.full_corpus_scan_batches(run_id, status, batch_index);

create or replace function public.touch_full_corpus_scan_run()
returns trigger
language plpgsql
as $$
begin
  update public.full_corpus_scan_runs r
  set updated_at = now(),
      completed_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'completed'),
      failed_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'failed'),
      analyzed_article_count = coalesce((select sum(article_count) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'completed'), 0)
  where r.id = new.run_id;
  return new;
end;
$$;

drop trigger if exists trg_touch_full_corpus_scan_run on public.full_corpus_scan_batches;
create trigger trg_touch_full_corpus_scan_run
after insert or update of status, article_count on public.full_corpus_scan_batches
for each row
execute function public.touch_full_corpus_scan_run();
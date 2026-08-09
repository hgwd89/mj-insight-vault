alter table public.full_corpus_scan_runs add column if not exists needs_review_batches integer not null default 0;

create or replace function public.touch_full_corpus_scan_run()
returns trigger
language plpgsql
as $$
begin
  update public.full_corpus_scan_runs r
  set updated_at = now(),
      completed_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'completed'),
      failed_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'failed'),
      needs_review_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'needs_review'),
      analyzed_article_count = coalesce((select sum(article_count) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'completed'), 0)
  where r.id = new.run_id;
  return new;
end;
$$;
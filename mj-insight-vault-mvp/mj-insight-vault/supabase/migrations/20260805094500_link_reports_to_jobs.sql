begin;

alter table public.chat_reports
  add column if not exists source_job_id uuid
  references public.chat_jobs(id)
  on delete set null;

create unique index if not exists chat_reports_source_job_id_uidx
  on public.chat_reports (source_job_id);

commit;

create or replace function public.auto_complete_chat_job_when_report_saved()
returns trigger
language plpgsql
as $$
begin
  if new.report_id is not null and coalesce(new.status, '') <> 'completed' then
    new.status := 'completed';
    new.progress := 100;
    new.stage := 'レポート生成完了';
    new.error_message := null;
    new.finished_at := coalesce(new.finished_at, now());
    new.heartbeat_at := now();
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_auto_complete_chat_job_when_report_saved on public.chat_jobs;

create trigger trg_auto_complete_chat_job_when_report_saved
before insert or update of report_id, status, progress, stage, finished_at on public.chat_jobs
for each row
execute function public.auto_complete_chat_job_when_report_saved();

update public.chat_jobs
set updated_at = now()
where report_id is not null
  and status <> 'completed';
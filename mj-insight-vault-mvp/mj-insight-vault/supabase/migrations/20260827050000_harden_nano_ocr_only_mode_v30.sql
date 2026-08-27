-- Nano hardening v30.
-- Snapshot every user pg_cron definition, then unschedule all jobs before any historical
-- OCR / Inventory / rollup / report automation can consume the free Nano compute again.
-- No source image, OCR text, article, receipt, provenance, or report data is deleted.

create table if not exists public.mj_ocr_only_cron_snapshot_v30 (
  captured_jobid bigint primary key,
  jobname text,
  schedule text not null,
  command text not null,
  database_name text,
  username_name text,
  was_active boolean not null,
  captured_at timestamptz not null default now()
);

revoke all on table public.mj_ocr_only_cron_snapshot_v30 from public, anon, authenticated;
grant select on table public.mj_ocr_only_cron_snapshot_v30 to postgres, service_role;

do $block$
declare
  r record;
begin
  if pg_catalog.to_regclass('cron.job') is not null then
    insert into public.mj_ocr_only_cron_snapshot_v30 (
      captured_jobid,
      jobname,
      schedule,
      command,
      database_name,
      username_name,
      was_active,
      captured_at
    )
    select
      j.jobid,
      j.jobname,
      j.schedule,
      j.command,
      j.database::text,
      j.username::text,
      coalesce(j.active, true),
      now()
    from cron.job j
    on conflict (captured_jobid) do update
      set jobname = excluded.jobname,
          schedule = excluded.schedule,
          command = excluded.command,
          database_name = excluded.database_name,
          username_name = excluded.username_name,
          was_active = excluded.was_active,
          captured_at = excluded.captured_at;

    for r in select j.jobid from cron.job j order by j.jobid loop
      perform cron.unschedule(r.jobid);
    end loop;

    if exists(select 1 from cron.job) then
      raise exception 'ocr_only_cron_shutdown_incomplete';
    end if;
  end if;
end
$block$;

comment on table public.mj_ocr_only_cron_snapshot_v30 is
  'Definitions of pg_cron jobs removed when MJ Insight Vault entered Nano OCR-only mode. Restore only by an explicit future full-pipeline operation.';

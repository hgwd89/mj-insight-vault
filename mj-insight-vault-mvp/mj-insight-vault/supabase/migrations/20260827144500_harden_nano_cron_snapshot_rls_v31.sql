-- Harden the Nano-mode pg_cron snapshot table in the exposed public schema.
-- The table contains operational commands and must not be reachable by anon/authenticated roles.

alter table if exists public.mj_ocr_only_cron_snapshot_v30 enable row level security;

revoke all on table public.mj_ocr_only_cron_snapshot_v30 from public, anon, authenticated;
grant select on table public.mj_ocr_only_cron_snapshot_v30 to postgres, service_role;

comment on table public.mj_ocr_only_cron_snapshot_v30 is
  'Internal snapshot of pg_cron definitions removed for Nano OCR-only mode. RLS enabled; access restricted to trusted server roles.';

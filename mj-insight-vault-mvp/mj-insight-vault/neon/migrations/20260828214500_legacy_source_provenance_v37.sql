-- Legacy Supabase rescue provenance v37.
-- Additive only. Supabase deletion remains forbidden until Drive copy verification is recorded.

alter table public.vault_source_files add column if not exists legacy_source_provider text;
alter table public.vault_source_files add column if not exists legacy_source_bucket text;
alter table public.vault_source_files add column if not exists legacy_source_path text;
alter table public.vault_source_files add column if not exists legacy_source_sha256 text;
alter table public.vault_source_files add column if not exists legacy_copy_verified_at timestamptz;
alter table public.vault_source_files add column if not exists legacy_source_deleted_at timestamptz;

create unique index if not exists vault_source_files_legacy_source_uidx
  on public.vault_source_files (legacy_source_provider, legacy_source_bucket, legacy_source_path)
  where legacy_source_path is not null;

create index if not exists vault_source_files_legacy_sha_idx
  on public.vault_source_files (legacy_source_sha256)
  where legacy_source_sha256 is not null;

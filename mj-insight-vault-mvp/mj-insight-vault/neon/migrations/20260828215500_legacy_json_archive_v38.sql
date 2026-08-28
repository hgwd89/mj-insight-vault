-- Legacy Supabase essential-data JSON archive v38.
-- Additive only. This is a rescue layer before structural migration to Neon.

create table if not exists public.vault_legacy_json_archive (
  id uuid primary key default gen_random_uuid(),
  source_table text not null,
  source_pk text not null,
  payload jsonb not null,
  payload_sha256 text not null,
  user_id text default auth.user_id() not null,
  archived_at timestamptz not null default now(),
  verified_at timestamptz,
  unique(user_id, source_table, source_pk)
);

create index if not exists vault_legacy_json_archive_table_idx
  on public.vault_legacy_json_archive (user_id, source_table, archived_at desc);

grant select, insert, update, delete on public.vault_legacy_json_archive to authenticated;
alter table public.vault_legacy_json_archive enable row level security;

drop policy if exists vault_legacy_json_archive_user_owns on public.vault_legacy_json_archive;
create policy vault_legacy_json_archive_user_owns on public.vault_legacy_json_archive
  for all to authenticated
  using ((select auth.user_id()) = user_id)
  with check ((select auth.user_id()) = user_id);

create or replace function public.vault_archive_legacy_json_v1(p_source_table text, p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_source_table is null or btrim(p_source_table) = '' then
    raise exception 'source_table_required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_array_required';
  end if;

  insert into public.vault_legacy_json_archive (
    source_table, source_pk, payload, payload_sha256, user_id, archived_at, verified_at
  )
  select
    p_source_table, x.source_pk, x.payload, x.payload_sha256,
    auth.user_id(), now(), now()
  from jsonb_to_recordset(p_rows)
    as x(source_pk text, payload jsonb, payload_sha256 text)
  where x.source_pk is not null
    and x.source_pk <> ''
    and x.payload is not null
    and x.payload_sha256 ~ '^[a-f0-9]{64}$'
  on conflict (user_id, source_table, source_pk)
  do update set
    payload = excluded.payload,
    payload_sha256 = excluded.payload_sha256,
    archived_at = now(),
    verified_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.vault_archive_legacy_json_v1(text, jsonb) to authenticated;

create or replace function public.vault_legacy_archive_status_v1()
returns table(source_table text, archived_count bigint, verified_count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    a.source_table,
    count(*)::bigint as archived_count,
    count(*) filter (where a.verified_at is not null)::bigint as verified_count
  from public.vault_legacy_json_archive a
  where a.user_id = (select auth.user_id())
  group by a.source_table
  order by a.source_table;
$$;

grant execute on function public.vault_legacy_archive_status_v1() to authenticated;

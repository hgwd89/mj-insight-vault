alter table public.source_images
  add column if not exists storage_etag text,
  add column if not exists storage_size_bytes bigint,
  add column if not exists storage_identity_version text;

update public.source_images s
set storage_etag=o.metadata->>'eTag',
    storage_size_bytes=case when coalesce(o.metadata->>'size','')~'^\d+$' then (o.metadata->>'size')::bigint else null end,
    storage_identity_version='storage_etag_size_v1'
from storage.objects o
where o.name=s.storage_path
  and (s.storage_etag is distinct from o.metadata->>'eTag'
       or s.storage_size_bytes is distinct from case when coalesce(o.metadata->>'size','')~'^\d+$' then (o.metadata->>'size')::bigint else null end
       or s.storage_identity_version is distinct from 'storage_etag_size_v1');

create index if not exists source_images_storage_etag_size_idx
on public.source_images(storage_etag,storage_size_bytes)
where storage_etag is not null and storage_size_bytes is not null;

create or replace function public.refresh_source_storage_identity_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public','storage'
as $$
declare m jsonb;begin
  select metadata into m from storage.objects where name=new.storage_path order by created_at desc limit 1;
  if m is not null then
    new.storage_etag:=m->>'eTag';
    new.storage_size_bytes:=case when coalesce(m->>'size','')~'^\d+$' then (m->>'size')::bigint else null end;
    new.storage_identity_version:='storage_etag_size_v1';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_00_refresh_source_storage_identity_v1 on public.source_images;
create trigger trg_00_refresh_source_storage_identity_v1
before insert or update of storage_path on public.source_images
for each row execute function public.refresh_source_storage_identity_v1();
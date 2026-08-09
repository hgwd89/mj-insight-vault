alter table public.source_images add column if not exists raw_ocr_sha256 text;
alter table public.source_images add column if not exists normalized_ocr_sha256 text;
alter table public.source_images add column if not exists file_sha256 text;
alter table public.source_images add column if not exists duplicate_of_source_image_id uuid references public.source_images(id) on delete set null;
alter table public.source_images add column if not exists duplicate_reason text;

update public.source_images
set raw_ocr_sha256=encode(extensions.digest(convert_to(coalesce(ocr_text_raw,''),'UTF8'),'sha256'),'hex'),
    normalized_ocr_sha256=encode(extensions.digest(convert_to(lower(regexp_replace(coalesce(ocr_text_raw,''),'[[:space:]]+','','g')),'UTF8'),'sha256'),'hex')
where coalesce(ocr_text_raw,'')<>''
  and (raw_ocr_sha256 is null or normalized_ocr_sha256 is null);

create index if not exists source_images_raw_ocr_sha256_idx on public.source_images(raw_ocr_sha256) where raw_ocr_sha256 is not null;
create index if not exists source_images_normalized_ocr_sha256_idx on public.source_images(normalized_ocr_sha256) where normalized_ocr_sha256 is not null;
create unique index if not exists source_images_file_sha256_uidx on public.source_images(file_sha256) where file_sha256 is not null;
create index if not exists source_images_duplicate_of_idx on public.source_images(duplicate_of_source_image_id) where duplicate_of_source_image_id is not null;

with ranked as (
  select id,normalized_ocr_sha256,
         first_value(id) over(partition by normalized_ocr_sha256 order by created_at,id) canonical_id,
         row_number() over(partition by normalized_ocr_sha256 order by created_at,id) rn
  from public.source_images
  where coalesce(normalized_ocr_sha256,'') ~ '^[0-9a-f]{64}$'
), d as (
  select id,canonical_id from ranked where rn>1
)
update public.source_images s
set duplicate_of_source_image_id=d.canonical_id,
    duplicate_reason='normalized_raw_ocr_sha256_exact_v1'
from d
where s.id=d.id and s.duplicate_of_source_image_id is null;

create or replace view public.source_image_duplicate_audit_v1 with (security_invoker=true) as
with stats as (
  select count(*)::bigint source_image_count,
         count(*) filter(where coalesce(ocr_text_raw,'')<>'')::bigint ocr_ready_source_image_count,
         count(*) filter(where duplicate_of_source_image_id is not null)::bigint exact_or_normalized_duplicate_source_image_count,
         count(*) filter(where file_sha256 is not null)::bigint file_hash_ready_source_image_count
  from public.source_images
), groups as (
  select count(*)::bigint normalized_duplicate_group_count
  from (
    select normalized_ocr_sha256
    from public.source_images
    where normalized_ocr_sha256 is not null
    group by normalized_ocr_sha256 having count(*)>1
  ) q
), near_pairs as (
  select count(*)::bigint near_duplicate_page_pair_count from public.source_image_near_duplicate_audit_v1
)
select s.*,g.normalized_duplicate_group_count,n.near_duplicate_page_pair_count,
       case
         when s.ocr_ready_source_image_count=0 then 'no_ocr_sources'
         when s.file_hash_ready_source_image_count<s.source_image_count then 'file_hash_backfill_unavailable_for_legacy_sources'
         when n.near_duplicate_page_pair_count>0 then 'near_duplicate_review_required'
         else 'passed'
       end source_image_integrity_status
from stats s cross join groups g cross join near_pairs n;

revoke all on public.source_image_duplicate_audit_v1 from public,anon,authenticated;
grant select on public.source_image_duplicate_audit_v1 to postgres,service_role;
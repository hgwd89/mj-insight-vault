begin;

create table if not exists public.source_region_materialization_receipts_v6(
  inventory_job_id uuid primary key references public.source_page_article_inventory_jobs_v1(id) on delete cascade,
  partition_job_id uuid not null unique references public.source_page_partition_jobs_v3(id) on delete cascade,
  page_identity_source_image_id uuid not null references public.source_images(id),
  evidence_source_image_id uuid not null references public.source_images(id),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id) on delete cascade,
  source_ocr_json_sha256 text not null check(source_ocr_json_sha256 ~ '^[0-9a-f]{64}$'),
  page_article_set_fingerprint text not null check(page_article_set_fingerprint ~ '^[0-9a-f]{64}$'),
  article_count integer not null check(article_count>0),
  block_count integer not null check(block_count>0),
  region_count integer not null check(region_count>0),
  region_set_fingerprint text not null check(region_set_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.source_region_materialization_receipts_v6 enable row level security;
revoke all on public.source_region_materialization_receipts_v6 from public,anon,authenticated,service_role;
grant select on public.source_region_materialization_receipts_v6 to service_role;
create index if not exists source_region_materialization_receipts_v6_freeze_idx on public.source_region_materialization_receipts_v6(freeze_receipt_id);
create index if not exists source_region_materialization_receipts_v6_page_idx on public.source_region_materialization_receipts_v6(page_identity_source_image_id);

create or replace function public.record_source_region_materialization_receipt_v6(p_inventory_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;p public.source_page_partition_jobs_v3%rowtype;v_count integer;v_fp text;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_inventory_job_id;
  if not found or j.status<>'completed' then raise exception 'source_region_receipt_v6_inventory_not_completed'; end if;
  select * into p from public.source_page_partition_jobs_v3
  where page_identity_source_image_id=j.page_identity_source_image_id
    and evidence_source_image_id=j.inventory_source_image_id
    and freeze_receipt_id=j.freeze_receipt_id
    and partition_version='source_region_v6_inventory_consensus'
    and source_ocr_json_sha256=j.source_ocr_json_sha256
    and page_article_set_fingerprint=j.page_article_set_fingerprint
    and status='completed'
  order by updated_at desc limit 1;
  if not found then raise exception 'source_region_receipt_v6_partition_job_missing'; end if;
  select count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(r.article_id::text||':'||r.source_region_sha256||':'||coalesce(r.partition_fingerprint,''),'|' order by r.article_id::text),''),'UTF8'),'sha256'),'hex')
    into v_count,v_fp
  from public.article_source_regions r
  where r.partition_job_id=p.id and r.region_version='source_region_v6_inventory_consensus' and r.quality_status='passed';
  if v_count<>j.existing_article_count or coalesce(v_fp,'')='' then raise exception 'source_region_receipt_v6_region_set_invalid'; end if;
  insert into public.source_region_materialization_receipts_v6(
    inventory_job_id,partition_job_id,page_identity_source_image_id,evidence_source_image_id,freeze_receipt_id,
    source_ocr_json_sha256,page_article_set_fingerprint,article_count,block_count,region_count,region_set_fingerprint,updated_at
  ) values(j.id,p.id,j.page_identity_source_image_id,j.inventory_source_image_id,j.freeze_receipt_id,
           j.source_ocr_json_sha256,j.page_article_set_fingerprint,j.existing_article_count,j.block_count,v_count,v_fp,now())
  on conflict(inventory_job_id) do update set partition_job_id=excluded.partition_job_id,page_identity_source_image_id=excluded.page_identity_source_image_id,
    evidence_source_image_id=excluded.evidence_source_image_id,freeze_receipt_id=excluded.freeze_receipt_id,source_ocr_json_sha256=excluded.source_ocr_json_sha256,
    page_article_set_fingerprint=excluded.page_article_set_fingerprint,article_count=excluded.article_count,block_count=excluded.block_count,
    region_count=excluded.region_count,region_set_fingerprint=excluded.region_set_fingerprint,updated_at=now();
  return p.id;
end
$function$;
revoke all on function public.record_source_region_materialization_receipt_v6(uuid) from public,anon,authenticated,service_role;

create or replace function public.trg_materialize_source_region_from_inventory_v6()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
begin
  if new.status='completed' and old.status is distinct from 'completed' then
    perform public.materialize_source_region_from_inventory_v6(new.id);
    perform public.record_source_region_materialization_receipt_v6(new.id);
  end if;
  return new;
end
$function$;

create or replace view public.source_region_inventory_gate_v6
with (security_invoker=true)
as
with fg as (select freeze_receipt_id from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed'),
expected as (
  select count(*)::integer article_count,count(distinct m.page_identity_source_image_id)::integer page_count
  from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id
), actual as (
  select count(*)::integer page_count,coalesce(sum(r.region_count),0)::integer article_count
  from public.source_region_materialization_receipts_v6 r join fg on fg.freeze_receipt_id=r.freeze_receipt_id
)
select expected.article_count expected_article_count,actual.article_count source_grounded_article_count,
       expected.page_count expected_page_count,actual.page_count source_grounded_page_count,
       actual.page_count job_count,actual.page_count completed_jobs,
       case when actual.article_count=expected.article_count and actual.page_count=expected.page_count then 'passed' else 'failed' end source_region_gate,
       case when actual.article_count<>expected.article_count then 'article_region_receipts_incomplete'
            when actual.page_count<>expected.page_count then 'page_region_receipts_incomplete'
            else null end source_region_gate_reason
from expected cross join actual;

revoke all on public.source_region_inventory_gate_v6 from public,anon,authenticated;
grant select on public.source_region_inventory_gate_v6 to service_role;

commit;
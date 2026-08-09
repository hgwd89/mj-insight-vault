create table public.formal_corpus_freeze_receipts_v1 (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null default 'all',
  scope_query text not null default '',
  freeze_version text not null default 'formal_corpus_freeze_v1',
  status text not null check(status in ('frozen','superseded')),
  article_count integer not null,
  source_capture_count integer not null,
  source_page_identity_count integer not null,
  article_set_fingerprint text not null check(article_set_fingerprint ~ '^[0-9a-f]{64}$'),
  source_truth_fingerprint text not null check(source_truth_fingerprint ~ '^[0-9a-f]{64}$'),
  page_identity_fingerprint text not null check(page_identity_fingerprint ~ '^[0-9a-f]{64}$'),
  zero_audit_json jsonb not null,
  created_at timestamptz not null default now()
);
create index formal_corpus_freeze_receipts_v1_scope_idx on public.formal_corpus_freeze_receipts_v1(scope_type,scope_query,created_at desc);

create function public.formal_corpus_freeze_snapshot_v1()
returns table(
  article_count integer,
  source_capture_count integer,
  source_page_identity_count integer,
  article_set_fingerprint text,
  source_truth_fingerprint text,
  page_identity_fingerprint text
)
language sql stable security definer set search_path=public,extensions as $$
with fc as materialized (
  select f.id,
         f.source_image_id,
         a.article_date_normalized,
         a.source_ocr_sha256,
         a.analysis_body_clean_sha256,
         m.page_identity_source_image_id
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
)
select count(*)::int,
       count(distinct source_image_id)::int,
       count(distinct page_identity_source_image_id)::int,
       encode(digest(convert_to(string_agg(id::text,'|' order by id::text),'UTF8'),'sha256'),'hex'),
       encode(digest(convert_to(string_agg(id::text||':'||source_image_id::text||':'||coalesce(article_date_normalized::text,'')||':'||coalesce(source_ocr_sha256,'')||':'||coalesce(analysis_body_clean_sha256,''),'|' order by id::text),'UTF8'),'sha256'),'hex'),
       encode(digest(convert_to(string_agg(id::text||':'||source_image_id::text||':'||page_identity_source_image_id::text,'|' order by id::text),'UTF8'),'sha256'),'hex')
from fc;
$$;

create view public.formal_corpus_freeze_gate_v1 as
with current_snapshot as (
  select * from public.formal_corpus_freeze_snapshot_v1()
), latest as (
  select * from public.formal_corpus_freeze_receipts_v1
  where scope_type='all' and scope_query='' and status='frozen'
  order by created_at desc limit 1
)
select c.article_count current_article_count,
       c.source_capture_count current_source_capture_count,
       c.source_page_identity_count current_source_page_identity_count,
       c.article_set_fingerprint current_article_set_fingerprint,
       c.source_truth_fingerprint current_source_truth_fingerprint,
       c.page_identity_fingerprint current_page_identity_fingerprint,
       l.id freeze_receipt_id,
       l.article_count frozen_article_count,
       l.source_capture_count frozen_source_capture_count,
       l.source_page_identity_count frozen_source_page_identity_count,
       case
         when l.id is null then 'failed'
         when c.article_count<>l.article_count then 'failed'
         when c.source_capture_count<>l.source_capture_count then 'failed'
         when c.source_page_identity_count<>l.source_page_identity_count then 'failed'
         when c.article_set_fingerprint<>l.article_set_fingerprint then 'failed'
         when c.source_truth_fingerprint<>l.source_truth_fingerprint then 'failed'
         when c.page_identity_fingerprint<>l.page_identity_fingerprint then 'failed'
         else 'passed'
       end freeze_gate,
       case
         when l.id is null then 'freeze_receipt_missing'
         when c.article_count<>l.article_count then 'article_count_changed'
         when c.source_capture_count<>l.source_capture_count then 'source_capture_count_changed'
         when c.source_page_identity_count<>l.source_page_identity_count then 'page_identity_count_changed'
         when c.article_set_fingerprint<>l.article_set_fingerprint then 'article_set_changed'
         when c.source_truth_fingerprint<>l.source_truth_fingerprint then 'source_truth_changed'
         when c.page_identity_fingerprint<>l.page_identity_fingerprint then 'page_identity_mapping_changed'
         else 'passed'
       end gate_reason
from current_snapshot c left join latest l on true;
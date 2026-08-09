begin;

create table public.verified_ocr_corpus_receipts_v5(
  id uuid primary key default gen_random_uuid(),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id) on delete cascade,
  article_count integer not null check(article_count>0),
  verification_set_fingerprint text not null check(verification_set_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(freeze_receipt_id,verification_set_fingerprint)
);
alter table public.verified_ocr_corpus_receipts_v5 enable row level security;
revoke all on public.verified_ocr_corpus_receipts_v5 from public,anon,authenticated,service_role;
grant select on public.verified_ocr_corpus_receipts_v5 to service_role;

create or replace function public.create_verified_ocr_corpus_receipt_v5()
returns uuid language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare v_freeze uuid;v_expected integer;v_count integer;v_fp text;v_id uuid;
begin
 if not exists(select 1 from public.ocr_verification_gate_v2 where ocr_verification_gate='passed') then raise exception 'verified_ocr_receipt_v5_gate_not_passed'; end if;
 select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
 select expected_articles into v_expected from public.ocr_verification_gate_v2;
 select count(*)::integer,
        encode(extensions.digest(convert_to(string_agg(v.article_id::text||':'||v.canonical_text_sha256||':'||v.source_region_sha256||':'||v.source_ocr_sha256||':'||coalesce(v.independent_response_id,''),'|' order by v.article_id::text),'UTF8'),'sha256'),'hex')
   into v_count,v_fp
 from public.article_ocr_verifications_v1 v
 join public.ocr_verification_page_jobs_v2 j on j.partition_job_id=v.partition_job_id and j.status='completed' and j.freeze_receipt_id=v_freeze
 where v.verification_version='article_ocr_verification_v5_crop_ocr_plus_independent_vision' and v.quality_status='passed';
 if v_count<>v_expected or coalesce(v_fp,'')='' then raise exception 'verified_ocr_receipt_v5_article_set_incomplete'; end if;
 insert into public.verified_ocr_corpus_receipts_v5(freeze_receipt_id,article_count,verification_set_fingerprint)
 values(v_freeze,v_count,v_fp)
 on conflict(freeze_receipt_id,verification_set_fingerprint) do update set article_count=excluded.article_count
 returning id into v_id;
 return v_id;
end
$function$;
revoke all on function public.create_verified_ocr_corpus_receipt_v5() from public,anon,authenticated;
grant execute on function public.create_verified_ocr_corpus_receipt_v5() to service_role;

create or replace view public.current_verified_ocr_corpus_receipt_v5
with (security_invoker=true)
as
select r.*
from public.verified_ocr_corpus_receipts_v5 r
join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=r.freeze_receipt_id
where exists(select 1 from public.ocr_verification_gate_v2 g where g.ocr_verification_gate='passed' and g.expected_articles=r.article_count)
order by r.created_at desc limit 1;
revoke all on public.current_verified_ocr_corpus_receipt_v5 from public,anon,authenticated;
grant select on public.current_verified_ocr_corpus_receipt_v5 to service_role;

alter table public.article_embedding_jobs_v4
  add column if not exists ocr_receipt_id uuid references public.verified_ocr_corpus_receipts_v5(id) on delete cascade,
  add column if not exists ocr_verification_set_fingerprint text;
alter table public.article_embeddings_v4
  add column if not exists ocr_receipt_id uuid references public.verified_ocr_corpus_receipts_v5(id) on delete cascade,
  add column if not exists ocr_verification_set_fingerprint text;
create index if not exists article_embedding_jobs_v4_ocr_receipt_idx on public.article_embedding_jobs_v4(ocr_receipt_id);
create index if not exists article_embeddings_v4_ocr_receipt_idx on public.article_embeddings_v4(ocr_receipt_id);

commit;
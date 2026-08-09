begin;
create table public.category_classification_corpus_receipts_v7(
  id uuid primary key default gen_random_uuid(),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id) on delete cascade,
  ocr_receipt_id uuid not null references public.verified_ocr_corpus_receipts_v5(id) on delete cascade,
  duplicate_audit_run_id uuid not null references public.source_grounded_duplicate_audit_runs_v5(id) on delete cascade,
  category_catalog_fingerprint text not null check(category_catalog_fingerprint ~ '^[0-9a-f]{64}$'),
  article_count integer not null check(article_count>0),
  profile_set_fingerprint text not null check(profile_set_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(ocr_receipt_id,duplicate_audit_run_id,category_catalog_fingerprint,profile_set_fingerprint)
);
alter table public.category_classification_corpus_receipts_v7 enable row level security;
revoke all on public.category_classification_corpus_receipts_v7 from public,anon,authenticated,service_role;
grant select on public.category_classification_corpus_receipts_v7 to service_role;

create or replace function public.record_category_classification_corpus_receipt_v7()
returns uuid
language plpgsql security definer
set search_path=pg_catalog,public,extensions
as $function$
declare v_ocr public.verified_ocr_corpus_receipts_v5%rowtype;v_run uuid;v_freeze uuid;v_count integer;v_catalog text;v_fp text;v_id uuid;
begin
  if (select category_classification_gate from public.article_classification_quality_gate_v6)<>'passed' then raise exception 'classification_receipt_v7_gate_required'; end if;
  select * into v_ocr from public.current_verified_ocr_corpus_receipt_v5;
  select audit_run_id into v_run from public.source_grounded_duplicate_gate_v6 where duplicate_gate='passed';
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_ocr.id is null or v_run is null or v_freeze is null then raise exception 'classification_receipt_v7_prerequisite_missing'; end if;
  select count(*)::integer,min(p.category_catalog_fingerprint),
         encode(extensions.digest(convert_to(coalesce(string_agg(
           p.article_id::text||':'||p.classification_input_sha256||':'||p.classification_status||':'||coalesce(p.primary_category,'')||':'||p.confidence::text||':'||
           coalesce((select string_agg(m.category_id||'='||m.score::text||'='||m.confidence::text,';' order by m.category_id) from public.article_category_memberships_v4 m where m.profile_id=p.id),'')
         ,'|' order by p.article_id::text),''),'UTF8'),'sha256'),'hex')
    into v_count,v_catalog,v_fp
  from public.formal_article_profiles_v6 p;
  if v_count<>v_ocr.article_count or v_count<=0 or coalesce(v_catalog,'')='' or coalesce(v_fp,'')='' then raise exception 'classification_receipt_v7_profile_set_invalid'; end if;
  insert into public.category_classification_corpus_receipts_v7(freeze_receipt_id,ocr_receipt_id,duplicate_audit_run_id,category_catalog_fingerprint,article_count,profile_set_fingerprint)
  values(v_freeze,v_ocr.id,v_run,v_catalog,v_count,v_fp)
  on conflict(ocr_receipt_id,duplicate_audit_run_id,category_catalog_fingerprint,profile_set_fingerprint) do update set freeze_receipt_id=excluded.freeze_receipt_id
  returning id into v_id;
  return v_id;
end
$function$;
revoke all on function public.record_category_classification_corpus_receipt_v7() from public,anon,authenticated;
grant execute on function public.record_category_classification_corpus_receipt_v7() to service_role;

create view public.current_category_classification_corpus_receipt_v7
with (security_invoker=true)
as
select r.*
from public.category_classification_corpus_receipts_v7 r
join public.current_verified_ocr_corpus_receipt_v5 o on o.id=r.ocr_receipt_id and o.freeze_receipt_id=r.freeze_receipt_id
join public.source_grounded_duplicate_gate_v6 d on d.duplicate_gate='passed' and d.audit_run_id=r.duplicate_audit_run_id
join public.article_classification_quality_gate_v6 c on c.category_classification_gate='passed' and c.formal_article_count=r.article_count
order by r.created_at desc
limit 1;
revoke all on public.current_category_classification_corpus_receipt_v7 from public,anon,authenticated;
grant select on public.current_category_classification_corpus_receipt_v7 to service_role;
commit;
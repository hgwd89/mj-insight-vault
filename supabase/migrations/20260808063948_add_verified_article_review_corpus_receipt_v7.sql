begin;
create table public.verified_article_review_corpus_receipts_v7(
  id uuid primary key default gen_random_uuid(),
  classification_receipt_id uuid not null unique references public.category_classification_corpus_receipts_v7(id) on delete cascade,
  article_count integer not null check(article_count>0),
  seed_count integer not null check(seed_count>=0),
  review_set_fingerprint text not null check(review_set_fingerprint ~ '^[0-9a-f]{64}$'),
  seed_set_fingerprint text not null check(seed_set_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.verified_article_review_corpus_receipts_v7 enable row level security;
revoke all on public.verified_article_review_corpus_receipts_v7 from public,anon,authenticated,service_role;
grant select on public.verified_article_review_corpus_receipts_v7 to service_role;

create or replace function public.record_verified_article_review_corpus_receipt_v7()
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare v_class uuid;v_articles integer;v_reviewed integer;v_seeds integer;v_review_fp text;v_seed_fp text;v_id uuid;
begin
  if (select review_gate from public.verified_article_review_gate_v6)<>'passed' then raise exception 'review_receipt_v7_gate_required'; end if;
  select id,article_count into v_class,v_articles from public.current_category_classification_corpus_receipt_v7;
  if v_class is null or v_articles<=0 then raise exception 'review_receipt_v7_classification_receipt_missing'; end if;
  select count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(
           r.article_id::text||':'||r.verified_text_sha256||':'||r.review_input_sha256||':'||r.subject||':'||r.measurement||':'||r.no_theme_signal::text||':'||
           encode(extensions.digest(convert_to(r.observed_fact||'|'||r.limitation||'|'||r.consumer_relevance,'UTF8'),'sha256'),'hex')
         ,'|' order by r.article_id::text),''),'UTF8'),'sha256'),'hex')
    into v_reviewed,v_review_fp
  from public.verified_article_reviews_v6 r where r.classification_receipt_id=v_class;
  select count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(
           s.article_id::text||':'||s.seed_label||':'||s.seed_statement||':'||s.subject||':'||s.measurement||':'||s.confidence::text||':'||s.source_anchor
         ,'|' order by s.article_id::text,s.id::text),''),'UTF8'),'sha256'),'hex')
    into v_seeds,v_seed_fp
  from public.verified_article_theme_seeds_v6 s
  join public.verified_article_reviews_v6 r on r.id=s.review_id and r.classification_receipt_id=v_class;
  if v_reviewed<>v_articles or coalesce(v_review_fp,'')='' or coalesce(v_seed_fp,'')='' then raise exception 'review_receipt_v7_set_invalid'; end if;
  insert into public.verified_article_review_corpus_receipts_v7(classification_receipt_id,article_count,seed_count,review_set_fingerprint,seed_set_fingerprint)
  values(v_class,v_articles,v_seeds,v_review_fp,v_seed_fp)
  on conflict(classification_receipt_id) do update set article_count=excluded.article_count,seed_count=excluded.seed_count,review_set_fingerprint=excluded.review_set_fingerprint,seed_set_fingerprint=excluded.seed_set_fingerprint,created_at=now()
  returning id into v_id;
  return v_id;
end
$function$;
revoke all on function public.record_verified_article_review_corpus_receipt_v7() from public,anon,authenticated;
grant execute on function public.record_verified_article_review_corpus_receipt_v7() to service_role;

create view public.current_verified_article_review_corpus_receipt_v7
with (security_invoker=true)
as
select r.*
from public.verified_article_review_corpus_receipts_v7 r
join public.current_category_classification_corpus_receipt_v7 c on c.id=r.classification_receipt_id and c.article_count=r.article_count
join public.verified_article_review_gate_v6 g on g.review_gate='passed' and g.reviewed=r.article_count
order by r.created_at desc limit 1;
revoke all on public.current_verified_article_review_corpus_receipt_v7 from public,anon,authenticated;
grant select on public.current_verified_article_review_corpus_receipt_v7 to service_role;
commit;
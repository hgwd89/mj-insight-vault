alter table public.full_corpus_scan_batches
  alter column evidence_article_ids drop default;

alter table public.full_corpus_scan_batches
  alter column evidence_article_ids type text[]
  using evidence_article_ids::text[];

alter table public.full_corpus_scan_batches
  alter column evidence_article_ids set default '{}'::text[];

create or replace function public.sanitize_full_corpus_scan_evidence_ids()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  allowed_ids text[];
  cleaned_ids text[];
  cleaned_evidence jsonb;
begin
  select coalesce(array_agg(value::text), '{}'::text[])
    into allowed_ids
  from unnest(coalesce(new.article_ids, '{}'::uuid[])) as value;

  select coalesce(array_agg(distinct value order by value), '{}'::text[])
    into cleaned_ids
  from unnest(coalesce(new.evidence_article_ids, '{}'::text[])) as value
  where value = any(allowed_ids);

  new.evidence_article_ids := cleaned_ids;

  if jsonb_typeof(new.summary_json -> 'evidence') = 'array' then
    select coalesce(jsonb_agg(item), '[]'::jsonb)
      into cleaned_evidence
    from jsonb_array_elements(new.summary_json -> 'evidence') as item
    where coalesce(item ->> 'article_id', item ->> 'id', '') = any(allowed_ids);

    new.summary_json := jsonb_set(
      coalesce(new.summary_json, '{}'::jsonb),
      '{evidence}',
      cleaned_evidence,
      true
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sanitize_full_corpus_scan_evidence_ids
  on public.full_corpus_scan_batches;

create trigger trg_sanitize_full_corpus_scan_evidence_ids
before insert or update of evidence_article_ids, summary_json
on public.full_corpus_scan_batches
for each row
execute function public.sanitize_full_corpus_scan_evidence_ids();

revoke all on function public.sanitize_full_corpus_scan_evidence_ids() from public;
grant execute on function public.sanitize_full_corpus_scan_evidence_ids() to service_role;
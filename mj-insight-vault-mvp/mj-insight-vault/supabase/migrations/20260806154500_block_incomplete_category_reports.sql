-- Category-wide reports are not full-corpus reports while formal articles remain
-- unprofiled or have no category membership.

create or replace view public.category_classification_gate_v1
with (security_invoker = true)
as
with formal as (
  select id from public.formal_corpus_articles_v1
),
profiled as (
  select distinct p.article_id
  from public.article_profiles p
  join formal f on f.id = p.article_id
),
categorized as (
  select distinct m.article_id
  from public.article_category_memberships m
  join formal f on f.id = m.article_id
),
invalid_memberships as (
  select count(*)::integer as n
  from public.article_category_memberships m
  left join public.analysis_categories c on c.id = m.category_id and c.is_active = true
  join formal f on f.id = m.article_id
  where c.id is null
)
select
  (select count(*)::integer from formal) as formal_article_count,
  (select count(*)::integer from profiled) as profiled_article_count,
  (select count(*)::integer from categorized) as categorized_article_count,
  (select count(*)::integer from formal f left join profiled p on p.article_id=f.id where p.article_id is null) as unprofiled_article_count,
  (select count(*)::integer from formal f left join categorized c on c.article_id=f.id where c.article_id is null) as uncategorized_article_count,
  (select n from invalid_memberships) as invalid_membership_count,
  case
    when (select count(*) from formal) = 0 then 'failed'
    when (select count(*) from formal) <> (select count(*) from profiled) then 'failed'
    when (select count(*) from formal) <> (select count(*) from categorized) then 'failed'
    when (select n from invalid_memberships) > 0 then 'failed'
    else 'passed'
  end as category_classification_gate,
  case
    when (select count(*) from formal) = 0 then 'no_formal_articles'
    when (select count(*) from formal) <> (select count(*) from profiled) then 'unprofiled_articles_exist'
    when (select count(*) from formal) <> (select count(*) from categorized) then 'uncategorized_articles_exist'
    when (select n from invalid_memberships) > 0 then 'inactive_or_missing_category_memberships_exist'
    else 'passed'
  end as gate_reason;

revoke all on public.category_classification_gate_v1 from public, anon, authenticated;
grant select on public.category_classification_gate_v1 to postgres, service_role;

create or replace function public.enforce_category_report_classification_v1()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  payload jsonb := coalesce(new.answer_json, '{}'::jsonb);
  target_scope text := coalesce(payload ->> 'target_scope', payload #>> '{source_coverage,scope_type}', '');
  category_id text := coalesce(payload ->> 'category_id', payload #>> '{source_coverage,scope_query}', '');
  corpus_gate text := coalesce(payload ->> 'full_corpus_gate', payload #>> '{source_coverage,full_corpus_gate}', 'failed');
  generation_status_value text := coalesce(payload ->> 'generation_status', 'completed');
  report_kind_value text := coalesce(payload ->> 'report_kind', '');
  report_chat boolean := lower(coalesce(payload ->> 'report_chat', 'false')) in ('true', '1', 'yes');
  classification_gate text;
  classification_reason text;
  category_exists boolean;
begin
  if target_scope <> 'category'
    or category_id = ''
    or corpus_gate <> 'passed'
    or generation_status_value = 'blocked'
    or report_kind_value = 'diagnostic'
    or report_chat then
    return new;
  end if;

  select exists(
    select 1 from public.analysis_categories c
    where c.id = category_id and c.is_active = true
  ) into category_exists;

  if not category_exists then
    raise exception using
      errcode = '23514',
      message = 'formal_category_id_invalid',
      detail = 'Formal category reports require an active analysis category.';
  end if;

  select category_classification_gate, gate_reason
    into classification_gate, classification_reason
  from public.category_classification_gate_v1;

  if classification_gate <> 'passed' then
    raise exception using
      errcode = '23514',
      message = 'formal_category_classification_incomplete',
      detail = classification_reason;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_00_enforce_category_report_classification_v1 on public.chat_reports;
create trigger trg_00_enforce_category_report_classification_v1
before insert or update of answer_json on public.chat_reports
for each row execute function public.enforce_category_report_classification_v1();

revoke all on function public.enforce_category_report_classification_v1() from public, anon, authenticated;
grant execute on function public.enforce_category_report_classification_v1() to postgres, service_role;

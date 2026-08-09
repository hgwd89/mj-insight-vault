create or replace function public.report_raw_evidence_integrity_v1(p_payload jsonb, p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  with evidence_items as (
    select item
    from jsonb_array_elements(
      case when jsonb_typeof(p_payload -> 'evidence_matrix') = 'array'
        then p_payload -> 'evidence_matrix'
        else '[]'::jsonb
      end
    ) item
  ),
  evidence_totals as (
    select count(*) as total_count from evidence_items
  ),
  valid_evidence as (
    select coalesce(item ->> 'article_id', item ->> 'id') as article_id
    from evidence_items
    where jsonb_typeof(item) = 'object'
      and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
      and coalesce(item ->> 'article_id', item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and length(btrim(coalesce(item ->> 'claim', item ->> 'theme', item ->> 'title', ''))) >= 8
      and lower(coalesce(item ->> 'claim', item ->> 'theme', item ->> 'title', '')) not like '%[object object]%'
      and lower(coalesce(item ->> 'claim', item ->> 'theme', item ->> 'title', '')) not in ('undefined', 'null')
      and length(btrim(coalesce(item ->> 'evidence_excerpt_or_fact', item ->> 'evidence_excerpt', item ->> 'observed_fact', item ->> 'excerpt', ''))) >= 20
      and lower(coalesce(item ->> 'evidence_excerpt_or_fact', item ->> 'evidence_excerpt', item ->> 'observed_fact', item ->> 'excerpt', '')) not like '%[object object]%'
      and length(btrim(coalesce(item ->> 'what_can_be_said', ''))) >= 10
      and lower(coalesce(item ->> 'what_can_be_said', '')) not like '%[object object]%'
      and length(btrim(coalesce(item ->> 'what_cannot_be_said', item ->> 'limitation', ''))) >= 10
      and lower(item::text) not like '%[object object]%'
      and lower(item::text) not like '%[object undefined]%'
      and exists (
        select 1 from public.formal_corpus_articles_v1 a
        where a.id = coalesce(item ->> 'article_id', item ->> 'id')::uuid
      )
      and exists (
        select 1 from public.full_corpus_scan_batches b
        where b.run_id = p_run_id
          and coalesce(item ->> 'article_id', item ->> 'id')::uuid = any(b.article_ids)
      )
  ),
  evidence_counts as (
    select count(*) as valid_count, count(distinct article_id) as distinct_count from valid_evidence
  ),
  refutation_ok as (
    select exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'refutation_audit') = 'array' then p_payload -> 'refutation_audit' else '[]'::jsonb end) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
        and length(btrim(coalesce(item ->> 'target_claim', ''))) >= 5
        and length(btrim(coalesce(item ->> 'falsification_condition', item ->> 'evidence_gap', ''))) >= 10
        and lower(item::text) not like '%[object object]%'
    ) as ok
  ),
  research_ok as (
    select exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'research_needs') = 'array' then p_payload -> 'research_needs' else '[]'::jsonb end) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
        and length(btrim(coalesce(item ->> 'question', item ->> 'research_question', ''))) >= 10
        and lower(item::text) not like '%[object object]%'
    ) as ok
  ),
  negative_ok as (
    select exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'negative_space') = 'array' then p_payload -> 'negative_space' else '[]'::jsonb end) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
        and length(btrim(coalesce(item ->> 'expected_but_weak_or_absent_theme', item ->> 'theme', ''))) >= 5
        and lower(item::text) not like '%[object object]%'
    ) as ok
  ),
  confidence_ok as (
    select exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(p_payload -> 'confidence_rubric') = 'array' then p_payload -> 'confidence_rubric' else '[]'::jsonb end) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
        and length(btrim(coalesce(item ->> 'claim', ''))) >= 5
        and length(btrim(coalesce(item ->> 'reason_for_uncertainty', item ->> 'limitation', ''))) >= 10
        and lower(item::text) not like '%[object object]%'
    ) as ok
  )
  select
    (select total_count between 5 and 12 from evidence_totals)
    and (select valid_count = total_count from evidence_counts cross join evidence_totals)
    and (select distinct_count = total_count from evidence_counts cross join evidence_totals)
    and lower(coalesce(p_payload ->> 'answer_text', '')) not like '%[object object]%'
    and regexp_count(coalesce(p_payload ->> 'answer_text', ''), '\]\(/articles/[0-9a-fA-F-]{36}\)') >= 3
    and (select ok from refutation_ok)
    and (select ok from research_ok)
    and (select ok from negative_ok)
    and (select ok from confidence_ok);
$function$;
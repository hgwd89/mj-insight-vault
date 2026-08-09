create or replace function public.report_raw_evidence_integrity_v1(p_payload jsonb,p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
with evidence_items as (
  select item
  from jsonb_array_elements(case when jsonb_typeof(p_payload->'evidence_matrix')='array' then p_payload->'evidence_matrix' else '[]'::jsonb end) item
), evidence_totals as (
  select count(*) total_count from evidence_items
), parsed_evidence as (
  select item,
    coalesce(item->>'article_id',item->>'id') article_id_text,
    btrim(coalesce(item->>'claim',item->>'theme',item->>'title','')) claim_text,
    btrim(coalesce(item->>'evidence_excerpt_or_fact',item->>'evidence_excerpt',item->>'observed_fact',item->>'excerpt','')) fact_text,
    btrim(coalesce(item->>'what_can_be_said','')) can_text,
    btrim(coalesce(item->>'what_cannot_be_said',item->>'limitation','')) cannot_text
  from evidence_items
), valid_evidence as (
  select p.article_id_text
  from parsed_evidence p
  join public.articles a on a.id=p.article_id_text::uuid
  where jsonb_typeof(p.item)='object'
    and lower(coalesce(p.item->>'synthetic_repair','false')) not in ('true','1','yes')
    and p.article_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and length(p.claim_text)>=8 and length(p.fact_text)>=20 and length(p.can_text)>=10 and length(p.cannot_text)>=10
    and lower(p.item::text) not like '%[object object]%'
    and lower(p.item::text) not like '%[object undefined]%'
    and lower(p.claim_text) not in ('undefined','null')
    and exists(select 1 from public.formal_corpus_articles_v1 f where f.id=a.id)
    and exists(select 1 from public.full_corpus_scan_batches b where b.run_id=p_run_id and a.id=any(b.article_ids))
    and (
      position(
        lower(regexp_replace(p.fact_text,'\s+',' ','g'))
        in lower(regexp_replace(coalesce(a.ocr_text,''),'\s+',' ','g'))
      )>0
      or extensions.word_similarity(
        lower(regexp_replace(p.fact_text,'\s+',' ','g')),
        lower(regexp_replace(coalesce(a.headline,'')||' '||coalesce(a.ocr_text,''),'\s+',' ','g'))
      )>=0.20
    )
), evidence_counts as (
  select count(*) valid_count,count(distinct article_id_text) distinct_count from valid_evidence
), refutation_ok as (
  select exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_payload->'refutation_audit')='array' then p_payload->'refutation_audit' else '[]'::jsonb end) item
    where jsonb_typeof(item)='object'
      and lower(coalesce(item->>'synthetic_repair','false')) not in ('true','1','yes')
      and length(btrim(coalesce(item->>'target_claim','')))>=5
      and length(btrim(coalesce(item->>'falsification_condition',item->>'evidence_gap','')))>=10
      and lower(item::text) not like '%[object object]%') ok
), research_ok as (
  select exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_payload->'research_needs')='array' then p_payload->'research_needs' else '[]'::jsonb end) item
    where jsonb_typeof(item)='object'
      and lower(coalesce(item->>'synthetic_repair','false')) not in ('true','1','yes')
      and length(btrim(coalesce(item->>'question',item->>'research_question',item->>'hypothesis_to_test','')))>=10
      and lower(item::text) not like '%[object object]%') ok
), negative_ok as (
  select exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_payload->'negative_space')='array' then p_payload->'negative_space' else '[]'::jsonb end) item
    where jsonb_typeof(item)='object'
      and lower(coalesce(item->>'synthetic_repair','false')) not in ('true','1','yes')
      and length(btrim(coalesce(item->>'expected_but_weak_or_absent_theme',item->>'theme','')))>=5
      and lower(item::text) not like '%[object object]%') ok
), confidence_ok as (
  select exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_payload->'confidence_rubric')='array' then p_payload->'confidence_rubric' else '[]'::jsonb end) item
    where jsonb_typeof(item)='object'
      and lower(coalesce(item->>'synthetic_repair','false')) not in ('true','1','yes')
      and length(btrim(coalesce(item->>'claim','')))>=5
      and length(btrim(coalesce(item->>'reason_for_uncertainty',item->>'limitation','')))>=10
      and lower(item::text) not like '%[object object]%') ok
)
select
  (select total_count between 5 and 12 from evidence_totals)
  and (select valid_count=total_count from evidence_counts cross join evidence_totals)
  and (select distinct_count=total_count from evidence_counts cross join evidence_totals)
  and lower(coalesce(p_payload->>'answer_text','')) not like '%[object object]%'
  and regexp_count(coalesce(p_payload->>'answer_text',''),'\]\(/articles/[0-9a-fA-F-]{36}\)')>=3
  and (select ok from refutation_ok)
  and (select ok from research_ok)
  and (select ok from negative_ok)
  and (select ok from confidence_ok);
$function$;
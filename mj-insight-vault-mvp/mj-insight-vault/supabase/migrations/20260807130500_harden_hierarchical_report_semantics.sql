create or replace function public.report_hierarchical_semantic_integrity_v1(p_payload jsonb)
returns boolean
language plpgsql
stable
set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
declare
  generation_path text := coalesce(p_payload->>'generation_path','');
  run_id_text text := coalesce(p_payload->>'full_corpus_run_id',p_payload#>>'{source_coverage,full_corpus_run_id}','');
  run_id uuid;
  total_count integer := 0;
  valid_count integer := 0;
  distinct_article_count integer := 0;
  theme_count integer := 0;
  direct_count integer := 0;
  supply_count integer := 0;
  distinct_batch_count integer := 0;
begin
  if generation_path <> 'full_corpus_hierarchical_theme_evidence_writer_v1' then
    return true;
  end if;

  if coalesce(p_payload->>'answer_text','') ~* '(https?://|www\.)' then
    return false;
  end if;

  if run_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  run_id := run_id_text::uuid;

  with items as (
    select item
    from jsonb_array_elements(
      case when jsonb_typeof(p_payload->'evidence_matrix')='array'
        then p_payload->'evidence_matrix'
        else '[]'::jsonb
      end
    ) item
  ), checked as (
    select
      i.item,
      a.id as article_id,
      b.batch_index as actual_batch_index,
      case when coalesce(i.item->>'batch_index','') ~ '^\d+$'
        then (i.item->>'batch_index')::integer
        else null
      end as stored_batch_index,
      coalesce(i.item->>'theme_id','') as theme_id,
      coalesce(i.item->>'evidence_type','') as evidence_type,
      btrim(coalesce(i.item->>'claim','')) as claim,
      btrim(coalesce(i.item->>'evidence_excerpt_or_fact','')) as fact,
      greatest(
        extensions.word_similarity(
          lower(regexp_replace(btrim(coalesce(i.item->>'claim','')),'\s+',' ','g')),
          lower(regexp_replace(coalesce(a.headline,''),'\s+',' ','g'))
        ),
        extensions.word_similarity(
          lower(regexp_replace(btrim(coalesce(i.item->>'claim','')),'\s+',' ','g')),
          lower(regexp_replace(btrim(coalesce(i.item->>'evidence_excerpt_or_fact','')),'\s+',' ','g'))
        ),
        extensions.word_similarity(
          lower(regexp_replace(btrim(coalesce(i.item->>'claim','')),'\s+',' ','g')),
          lower(regexp_replace(coalesce(a.headline,'')||' '||btrim(coalesce(i.item->>'evidence_excerpt_or_fact','')),'\s+',' ','g'))
        )
      ) as semantic_score
    from items i
    left join public.articles a
      on a.id = case
        when coalesce(i.item->>'article_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (i.item->>'article_id')::uuid
        else null
      end
    left join public.full_corpus_scan_batches b
      on b.run_id = run_id
     and a.id = any(b.article_ids)
  )
  select
    count(*),
    count(*) filter (
      where article_id is not null
        and actual_batch_index is not null
        and stored_batch_index = actual_batch_index
        and theme_id ~ '^T[0-9]+$'
        and evidence_type in ('consumer_survey','purchase_behavior','usage_behavior','consumer_quote','supply_signal')
        and length(claim) >= 15
        and length(fact) >= 20
        and semantic_score >= 0.055
    ),
    count(distinct article_id),
    count(distinct theme_id) filter (where theme_id ~ '^T[0-9]+$'),
    count(*) filter (where evidence_type in ('consumer_survey','purchase_behavior','usage_behavior','consumer_quote')),
    count(*) filter (where evidence_type='supply_signal'),
    count(distinct actual_batch_index)
  into total_count, valid_count, distinct_article_count, theme_count, direct_count, supply_count, distinct_batch_count
  from checked;

  return total_count between 5 and 12
    and valid_count = total_count
    and distinct_article_count = total_count
    and theme_count >= 4
    and direct_count >= 3
    and supply_count <= 2
    and distinct_batch_count >= 4;
end;
$function$;

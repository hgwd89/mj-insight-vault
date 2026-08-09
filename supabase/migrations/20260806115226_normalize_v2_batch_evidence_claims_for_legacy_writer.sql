with target_run as (
  select r.id
  from public.full_corpus_scan_runs r
  where r.scope_type='all'
    and r.scope_query is null
    and r.status='completed'
    and r.failed_batches=0
    and r.needs_review_batches=0
    and exists (
      select 1 from public.full_corpus_scan_batches b
      where b.run_id=r.id and b.prompt_version='full_corpus_batch_v2'
    )
  order by r.created_at desc
  limit 1
), rebuilt as (
  select b.id,
         jsonb_agg(
           case
             when length(btrim(coalesce(e.item->>'claim','')))>=8
                  and lower(coalesce(e.item->>'claim','')) not like '%[object object]%'
             then e.item
             else jsonb_set(
               e.item,
               '{claim}',
               to_jsonb(left(coalesce(
                 nullif(btrim(e.item->>'theme'),''),
                 nullif(btrim(e.item->>'signal'),''),
                 nullif(btrim(e.item->>'consumer_narrative'),''),
                 nullif(btrim(e.item->>'observed_fact'),''),
                 nullif(btrim(e.item->>'what_can_be_said'),''),
                 nullif(btrim(e.item->>'evidence_excerpt_or_fact'),''),
                 nullif(btrim(e.item->>'evidence_excerpt'),''),
                 nullif(btrim(e.item->>'excerpt'),''),
                 '記事本文で観察された事実'
               ),240)),
               true
             )
           end
           order by e.ordinality
         ) as evidence
  from public.full_corpus_scan_batches b
  join target_run r on r.id=b.run_id
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(b.summary_json->'evidence')='array'
      then b.summary_json->'evidence'
      else '[]'::jsonb
    end
  ) with ordinality e(item,ordinality)
  group by b.id
)
update public.full_corpus_scan_batches b
set summary_json=jsonb_set(b.summary_json,'{evidence}',rebuilt.evidence,true),
    updated_at=now()
from rebuilt
where b.id=rebuilt.id;
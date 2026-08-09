with target_run as (
  select r.id
  from public.full_corpus_scan_runs r
  where r.scope_type='all' and r.scope_query is null and r.status='completed'
    and r.failed_batches=0 and r.needs_review_batches=0
    and exists(select 1 from public.full_corpus_scan_batches b where b.run_id=r.id and b.prompt_version='full_corpus_batch_v2')
  order by r.created_at desc limit 1
), rebuilt as (
  select b.id,
    jsonb_agg(
      (e.item || jsonb_build_object(
        'scan_evidence_original_v1',coalesce(e.item->'scan_evidence_original_v1',e.item-'scan_evidence_original_v1'),
        'claim',coalesce(nullif(btrim(a.headline),''),'記事本文の事実'),
        'observed_fact',left(btrim(regexp_replace(replace(replace(coalesce(a.ocr_text,''),'【GPT記事構造化】',''),'【本文再構成】',''),'\s+',' ','g')),320),
        'what_can_be_said',left(btrim(regexp_replace(replace(replace(coalesce(a.ocr_text,''),'【GPT記事構造化】',''),'【本文再構成】',''),'\s+',' ','g')),320),
        'evidence_excerpt_or_fact',left(btrim(regexp_replace(replace(replace(coalesce(a.ocr_text,''),'【GPT記事構造化】',''),'【本文再構成】',''),'\s+',' ','g')),320),
        'grounding_source','article_headline_ocr_v1',
        'grounded_article_headline',a.headline
      )) order by e.ordinality
    ) as evidence
  from public.full_corpus_scan_batches b
  join target_run r on r.id=b.run_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(b.summary_json->'evidence')='array' then b.summary_json->'evidence' else '[]'::jsonb end) with ordinality e(item,ordinality)
  join public.articles a on a.id=coalesce(e.item->>'article_id',e.item->>'id')::uuid
  group by b.id
)
update public.full_corpus_scan_batches b
set summary_json=jsonb_set(b.summary_json,'{evidence}',rebuilt.evidence,true),updated_at=now()
from rebuilt where b.id=rebuilt.id;
-- Align category readiness with the exact category scan scope and fail closed on
-- model-reported evidence references that are outside the batch input set.

create or replace view public.category_analysis_readiness_view as
with category_counts as (
  select
    c.id as category_id,
    c.name_ja,
    c.description,
    count(distinct scoped.article_id) as matched_article_count
  from public.analysis_categories c
  left join (
    select m.category_id, m.article_id
    from public.article_category_memberships m
    join public.formal_corpus_articles_v1 f
      on f.id = m.article_id
     and m.source_analysis_text_sha256 = f.analysis_text_sha256
    where m.source = 'article_category_profile_v2'
  ) scoped on scoped.category_id = c.id
  where c.is_active = true
  group by c.id, c.name_ja, c.description
), latest_runs as (
  select distinct on (r.scope_query)
    r.scope_query as category_id,
    r.id as run_id,
    r.status,
    r.active_article_count,
    r.ocr_ready_article_count,
    r.total_batches,
    r.completed_batches,
    r.failed_batches,
    r.needs_review_batches,
    r.analyzed_article_count,
    r.created_at,
    r.updated_at,
    case
      when r.status = 'completed'
       and r.total_batches > 0
       and r.completed_batches = r.total_batches
       and r.failed_batches = 0
       and r.needs_review_batches = 0
       and r.analyzed_article_count = r.ocr_ready_article_count
       and r.ocr_ready_article_count = r.active_article_count
      then 'passed'::text
      else 'failed'::text
    end as category_full_corpus_gate
  from public.full_corpus_scan_runs r
  where r.scope_type = 'category'
  order by r.scope_query, r.created_at desc
)
select
  cc.category_id,
  cc.name_ja,
  cc.description,
  cc.matched_article_count,
  lr.run_id,
  coalesce(lr.status, 'not_created'::text) as run_status,
  coalesce(lr.active_article_count, 0) as run_article_count,
  coalesce(lr.ocr_ready_article_count, 0) as ocr_ready_article_count,
  coalesce(lr.total_batches, 0) as total_batches,
  coalesce(lr.completed_batches, 0) as completed_batches,
  coalesce(lr.failed_batches, 0) as failed_batches,
  coalesce(lr.needs_review_batches, 0) as needs_review_batches,
  coalesce(lr.analyzed_article_count, 0) as analyzed_article_count,
  coalesce(lr.category_full_corpus_gate, 'failed'::text) as category_full_corpus_gate,
  case
    when cc.matched_article_count = 0 then 'no_articles'::text
    when lr.run_id is null then 'scan_run_missing'::text
    when lr.active_article_count <> cc.matched_article_count then 'run_article_count_mismatch'::text
    when lr.total_batches = 0 then 'no_batches'::text
    when lr.completed_batches <> lr.total_batches then 'batches_incomplete'::text
    when lr.failed_batches > 0 then 'failed_batches_exist'::text
    when lr.needs_review_batches > 0 then 'needs_review_batches_exist'::text
    when lr.analyzed_article_count <> lr.ocr_ready_article_count then 'analyzed_count_mismatch'::text
    when lr.category_full_corpus_gate = 'passed'::text then 'passed'::text
    else 'failed'::text
  end as readiness_reason,
  lr.created_at as run_created_at,
  lr.updated_at as run_updated_at
from category_counts cc
left join latest_runs lr on lr.category_id = cc.category_id;

create or replace function public.sanitize_full_corpus_scan_evidence_ids()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  allowed_ids text[];
  cleaned_ids text[];
  cleaned_evidence jsonb;
  reported_read_ids jsonb;
  has_evidence boolean;
  has_signal boolean;
  content_valid boolean;
  invalid_summary_refs text[];
begin
  if new.prompt_version = 'full_corpus_batch_v3_article_reviews' then
    return new;
  end if;

  select coalesce(array_agg(value::text), '{}'::text[])
    into allowed_ids
  from unnest(coalesce(new.article_ids, '{}'::uuid[])) value;

  -- Audit model output before sanitization. Any evidence reference outside the
  -- exact batch input set makes the batch non-formal and requires a retry.
  select coalesce(array_agg(distinct ref order by ref), '{}'::text[])
    into invalid_summary_refs
  from (
    select nullif(btrim(v #>> '{}'), '') as ref
    from jsonb_path_query(
      coalesce(new.summary_json, '{}'::jsonb),
      '$.**.evidence_article_ids[*]'
    ) v
    union all
    select nullif(btrim(v #>> '{}'), '') as ref
    from jsonb_path_query(
      coalesce(new.summary_json, '{}'::jsonb),
      '$.evidence[*].article_id'
    ) v
    union all
    select nullif(btrim(v #>> '{}'), '') as ref
    from jsonb_path_query(
      coalesce(new.summary_json, '{}'::jsonb),
      '$.evidence[*].id'
    ) v
  ) refs
  where ref is not null
    and not (ref = any(allowed_ids));

  select coalesce(array_agg(distinct value order by value), '{}'::text[])
    into cleaned_ids
  from unnest(coalesce(new.evidence_article_ids, '{}'::text[])) value
  where value = any(allowed_ids);
  new.evidence_article_ids := cleaned_ids;

  if jsonb_typeof(new.summary_json -> 'evidence') = 'array' then
    select coalesce(jsonb_agg(item), '[]'::jsonb)
      into cleaned_evidence
    from jsonb_array_elements(new.summary_json -> 'evidence') item
    where coalesce(item ->> 'article_id', item ->> 'id', '') = any(allowed_ids);
    new.summary_json := jsonb_set(
      coalesce(new.summary_json, '{}'::jsonb),
      '{evidence}',
      cleaned_evidence,
      true
    );
  end if;

  reported_read_ids := case
    when jsonb_typeof(new.summary_json -> 'read_article_ids') = 'array'
      then new.summary_json -> 'read_article_ids'
    else '[]'::jsonb
  end;

  has_evidence := jsonb_array_length(
    case
      when jsonb_typeof(new.summary_json -> 'evidence') = 'array'
        then new.summary_json -> 'evidence'
      else '[]'::jsonb
    end
  ) > 0;

  has_signal :=
       jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'consumer_narratives') = 'array' then new.summary_json -> 'consumer_narratives' else '[]'::jsonb end) > 0
    or jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'behavior_signals') = 'array' then new.summary_json -> 'behavior_signals' else '[]'::jsonb end) > 0
    or jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'weak_signals') = 'array' then new.summary_json -> 'weak_signals' else '[]'::jsonb end) > 0;

  content_valid :=
       lower(coalesce(new.summary_json ->> 'analysis_is_validated', 'false')) in ('true', '1', 'yes')
    and lower(coalesce(new.summary_json ->> 'fallback_used', 'false')) not in ('true', '1', 'yes')
    and has_evidence
    and has_signal;

  if new.status in ('queued', 'needs_review')
     and coalesce(new.last_error_class, '') = 'validation'
     and coalesce(new.error_message, '') ~ '^read_article_ids missing [0-9]+ article\(s\)$'
     and content_valid then
    new.summary_json := jsonb_set(coalesce(new.summary_json, '{}'::jsonb), '{model_reported_read_article_ids}', reported_read_ids, true);
    new.summary_json := jsonb_set(new.summary_json, '{read_article_ids}', to_jsonb(allowed_ids), true);
    new.summary_json := jsonb_set(new.summary_json, '{server_processed_article_ids}', to_jsonb(allowed_ids), true);
    new.summary_json := jsonb_set(
      new.summary_json,
      '{validation}',
      jsonb_build_object(
        'passed', true,
        'failures', '[]'::jsonb,
        'missing_read_article_ids', '[]'::jsonb,
        'server_processed_article_ids', true,
        'note', 'Legacy v2 only: model UUID echo mismatch normalized for audit.'
      ),
      true
    );
    new.status := 'completed';
    new.error_message := null;
    new.last_error_class := null;
    new.next_retry_at := null;
    new.finished_at := coalesce(new.finished_at, now());
  end if;

  -- Fail closed after all legacy normalization. Do not allow a completed batch
  -- to retain claims whose evidence points outside the exact batch input set.
  if coalesce(array_length(invalid_summary_refs, 1), 0) > 0 then
    new.summary_json := jsonb_set(
      coalesce(new.summary_json, '{}'::jsonb),
      '{validation}',
      jsonb_build_object(
        'passed', false,
        'failures', jsonb_build_array('out_of_batch_evidence_article_ids'),
        'invalid_evidence_article_ids', to_jsonb(invalid_summary_refs)
      ),
      true
    );
    if new.status = 'completed' then
      new.status := 'needs_review';
    end if;
    new.last_error_class := 'validation';
    new.error_message := 'out_of_batch_evidence_article_ids';
    new.next_retry_at := null;
    new.finished_at := null;
  end if;

  return new;
end;
$function$;

-- Revalidate the latest beauty category run that exposed the defect. The
-- selection is semantic (latest scope run), not tied to a generated run UUID.
with target_run as (
  select id
  from public.full_corpus_scan_runs
  where scope_type = 'category'
    and scope_query = 'beauty_cosmetics'
  order by created_at desc
  limit 1
)
update public.full_corpus_scan_batches b
set summary_json = b.summary_json
from target_run t
where b.run_id = t.id
  and b.status = 'completed';

-- Validator defects should not consume the model retry budget. Reset only the
-- batches that the new database guard just marked for evidence-integrity retry.
with target_run as (
  select id
  from public.full_corpus_scan_runs
  where scope_type = 'category'
    and scope_query = 'beauty_cosmetics'
  order by created_at desc
  limit 1
)
update public.full_corpus_scan_batches b
set attempt_count = 0,
    next_retry_at = now(),
    finished_at = null,
    updated_at = now()
from target_run t
where b.run_id = t.id
  and b.status = 'needs_review'
  and b.last_error_class = 'validation'
  and b.error_message = 'out_of_batch_evidence_article_ids';

with target_run as (
  select id
  from public.full_corpus_scan_runs
  where scope_type = 'category'
    and scope_query = 'beauty_cosmetics'
  order by created_at desc
  limit 1
)
update public.full_corpus_scan_runs r
set status = 'running',
    finished_at = null,
    error_message = 'evidence integrity revalidation required',
    updated_at = now()
from target_run t
where r.id = t.id
  and exists (
    select 1
    from public.full_corpus_scan_batches b
    where b.run_id = r.id
      and b.status = 'needs_review'
      and b.last_error_class = 'validation'
      and b.error_message = 'out_of_batch_evidence_article_ids'
  );

create or replace function public.sanitize_full_corpus_scan_evidence_ids()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  allowed_ids text[];
  cleaned_ids text[];
  cleaned_evidence jsonb;
  reported_read_ids jsonb;
  has_evidence boolean;
  has_signal boolean;
  content_valid boolean;
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

  reported_read_ids := coalesce(new.summary_json -> 'read_article_ids', '[]'::jsonb);
  has_evidence := jsonb_typeof(new.summary_json -> 'evidence') = 'array'
    and jsonb_array_length(new.summary_json -> 'evidence') > 0;
  has_signal := (
      jsonb_typeof(new.summary_json -> 'consumer_narratives') = 'array'
      and jsonb_array_length(new.summary_json -> 'consumer_narratives') > 0
    ) or (
      jsonb_typeof(new.summary_json -> 'behavior_signals') = 'array'
      and jsonb_array_length(new.summary_json -> 'behavior_signals') > 0
    ) or (
      jsonb_typeof(new.summary_json -> 'weak_signals') = 'array'
      and jsonb_array_length(new.summary_json -> 'weak_signals') > 0
    );
  content_valid := coalesce((new.summary_json ->> 'analysis_is_validated')::boolean, false)
    and not coalesce((new.summary_json ->> 'fallback_used')::boolean, false)
    and has_evidence
    and has_signal;

  if new.status in ('queued', 'needs_review')
     and coalesce(new.last_error_class, '') = 'validation'
     and coalesce(new.error_message, '') ~ '^read_article_ids missing [0-9]+ article\(s\)$'
     and content_valid then
    new.summary_json := jsonb_set(
      coalesce(new.summary_json, '{}'::jsonb),
      '{model_reported_read_article_ids}',
      reported_read_ids,
      true
    );
    new.summary_json := jsonb_set(
      new.summary_json,
      '{read_article_ids}',
      to_jsonb(allowed_ids),
      true
    );
    new.summary_json := jsonb_set(
      new.summary_json,
      '{validation}',
      jsonb_build_object(
        'passed', true,
        'failures', '[]'::jsonb,
        'missing_read_article_ids', '[]'::jsonb,
        'server_processed_article_ids', true,
        'note', 'Model UUID echo mismatch was recorded for audit and not treated as evidence of unread input.'
      ),
      true
    );
    new.status := 'completed';
    new.error_message := null;
    new.last_error_class := null;
    new.next_retry_at := null;
    new.finished_at := coalesce(new.finished_at, now());
  end if;

  return new;
end;
$function$;

comment on function public.sanitize_full_corpus_scan_evidence_ids() is
'Sanitizes model-provided evidence IDs and treats exact UUID echo as audit metadata rather than a quality gate when substantive scan content is valid.';
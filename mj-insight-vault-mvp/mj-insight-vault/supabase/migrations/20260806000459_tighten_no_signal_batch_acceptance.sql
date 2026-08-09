create or replace function public.accept_validated_no_signal_scan_batch()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_validated boolean;
  v_has_evidence boolean;
  v_has_signal boolean;
  v_failures jsonb;
  v_expected_failure constant text := 'consumer_narratives / behavior_signals / weak_signals are all empty';
  v_processed_ids jsonb;
begin
  if new.summary_json is null
    or coalesce(new.last_error_class, '') <> 'validation'
    or new.status not in ('queued', 'needs_review') then
    return new;
  end if;

  v_validated := lower(coalesce(new.summary_json ->> 'analysis_is_validated', 'false')) = 'true'
    and lower(coalesce(new.summary_json ->> 'fallback_used', 'false')) <> 'true';

  v_has_evidence := jsonb_typeof(new.summary_json -> 'evidence') = 'array'
    and jsonb_array_length(new.summary_json -> 'evidence') > 0;

  v_has_signal := (
      jsonb_typeof(new.summary_json -> 'consumer_narratives') = 'array'
      and jsonb_array_length(new.summary_json -> 'consumer_narratives') > 0
    ) or (
      jsonb_typeof(new.summary_json -> 'behavior_signals') = 'array'
      and jsonb_array_length(new.summary_json -> 'behavior_signals') > 0
    ) or (
      jsonb_typeof(new.summary_json -> 'weak_signals') = 'array'
      and jsonb_array_length(new.summary_json -> 'weak_signals') > 0
    );

  v_failures := coalesce(new.summary_json #> '{validation,failures}', '[]'::jsonb);

  if not v_validated
    or not v_has_evidence
    or v_has_signal
    or coalesce(new.error_message, '') <> v_expected_failure
    or jsonb_typeof(v_failures) <> 'array'
    or jsonb_array_length(v_failures) <> 1
    or v_failures ->> 0 <> v_expected_failure then
    return new;
  end if;

  select coalesce(jsonb_agg(article_id::text), '[]'::jsonb)
    into v_processed_ids
  from unnest(coalesce(new.article_ids, '{}'::uuid[])) as article_id;

  new.summary_json := jsonb_set(
    new.summary_json,
    '{server_processed_article_ids}',
    v_processed_ids,
    true
  );
  new.summary_json := jsonb_set(new.summary_json, '{no_signal_batch}', 'true'::jsonb, true);
  new.summary_json := jsonb_set(
    new.summary_json,
    '{validation}',
    jsonb_build_object(
      'passed', true,
      'failures', '[]'::jsonb,
      'missing_read_article_ids', '[]'::jsonb,
      'accepted_as_no_signal_batch', true,
      'note', 'No consumer narrative or signal was detected; evidence and model-reported read IDs were preserved.'
    ),
    true
  );

  new.status := 'completed';
  new.finished_at := coalesce(new.finished_at, now());
  new.updated_at := now();
  new.next_retry_at := null;
  new.last_error_class := null;
  new.error_message := null;

  return new;
end;
$$;

alter function public.accept_validated_no_signal_scan_batch() owner to postgres;
revoke all on function public.accept_validated_no_signal_scan_batch() from public, anon, authenticated;

grant execute on function public.accept_validated_no_signal_scan_batch() to service_role;

alter function public.sanitize_full_corpus_scan_evidence_ids() set search_path = pg_catalog, public;
revoke all on function public.sanitize_full_corpus_scan_evidence_ids() from public, anon, authenticated;
grant execute on function public.sanitize_full_corpus_scan_evidence_ids() to service_role;

alter function public.touch_full_corpus_scan_run() set search_path = pg_catalog, public;
revoke all on function public.touch_full_corpus_scan_run() from public, anon, authenticated;
grant execute on function public.touch_full_corpus_scan_run() to service_role;
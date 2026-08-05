-- A corpus batch can legitimately contain no consumer narrative or behavior signal.
-- Treat that outcome as a valid negative finding when the model explicitly validated
-- the analysis and returned article-level evidence. This prevents irrelevant or
-- low-signal article groups from exhausting the validation retry budget.

create or replace function public.accept_validated_no_signal_scan_batch()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_validated boolean;
  v_has_evidence boolean;
  v_has_signal boolean;
  v_read_ids jsonb;
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

  if not v_validated or not v_has_evidence or v_has_signal then
    return new;
  end if;

  select coalesce(jsonb_agg(article_id::text), '[]'::jsonb)
    into v_read_ids
  from unnest(coalesce(new.article_ids, '{}'::uuid[])) as article_id;

  new.summary_json := jsonb_set(new.summary_json, '{read_article_ids}', v_read_ids, true);
  new.summary_json := jsonb_set(new.summary_json, '{no_signal_batch}', 'true'::jsonb, true);
  new.summary_json := jsonb_set(
    new.summary_json,
    '{validation}',
    jsonb_build_object(
      'passed', true,
      'failures', '[]'::jsonb,
      'missing_read_article_ids', '[]'::jsonb,
      'accepted_as_no_signal_batch', true
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

drop trigger if exists trg_accept_validated_no_signal_scan_batch
  on public.full_corpus_scan_batches;

create trigger trg_accept_validated_no_signal_scan_batch
before insert or update of status, summary_json, last_error_class
on public.full_corpus_scan_batches
for each row
execute function public.accept_validated_no_signal_scan_batch();

revoke all on function public.accept_validated_no_signal_scan_batch() from public;
grant execute on function public.accept_validated_no_signal_scan_batch() to service_role;

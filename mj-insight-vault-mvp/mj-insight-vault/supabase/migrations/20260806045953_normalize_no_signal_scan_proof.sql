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
  v_allowed_ids jsonb;
  v_reported_read_ids jsonb;
begin
  if new.summary_json is null or coalesce(new.last_error_class, '') <> 'validation' or new.status not in ('queued', 'needs_review') then return new; end if;
  v_validated := lower(coalesce(new.summary_json ->> 'analysis_is_validated', 'false')) in ('true', '1', 'yes') and lower(coalesce(new.summary_json ->> 'fallback_used', 'false')) not in ('true', '1', 'yes');
  v_has_evidence := jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'evidence') = 'array' then new.summary_json -> 'evidence' else '[]'::jsonb end) > 0;
  v_has_signal := jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'consumer_narratives') = 'array' then new.summary_json -> 'consumer_narratives' else '[]'::jsonb end) > 0 or jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'behavior_signals') = 'array' then new.summary_json -> 'behavior_signals' else '[]'::jsonb end) > 0 or jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'weak_signals') = 'array' then new.summary_json -> 'weak_signals' else '[]'::jsonb end) > 0;
  v_failures := case when jsonb_typeof(new.summary_json #> '{validation,failures}') = 'array' then new.summary_json #> '{validation,failures}' else '[]'::jsonb end;
  if not v_validated or not v_has_evidence or v_has_signal or coalesce(new.error_message, '') <> v_expected_failure or jsonb_array_length(v_failures) <> 1 or v_failures ->> 0 <> v_expected_failure then return new; end if;
  select coalesce(jsonb_agg(article_id::text order by article_id::text), '[]'::jsonb) into v_allowed_ids from unnest(coalesce(new.article_ids, '{}'::uuid[])) article_id;
  v_reported_read_ids := case when jsonb_typeof(new.summary_json -> 'read_article_ids') = 'array' then new.summary_json -> 'read_article_ids' else '[]'::jsonb end;
  new.summary_json := jsonb_set(new.summary_json, '{model_reported_read_article_ids}', v_reported_read_ids, true);
  new.summary_json := jsonb_set(new.summary_json, '{read_article_ids}', v_allowed_ids, true);
  new.summary_json := jsonb_set(new.summary_json, '{server_processed_article_ids}', v_allowed_ids, true);
  new.summary_json := jsonb_set(new.summary_json, '{no_signal_detected}', 'true'::jsonb, true);
  new.summary_json := jsonb_set(new.summary_json, '{no_signal_batch}', 'true'::jsonb, true);
  new.summary_json := jsonb_set(new.summary_json, '{validation}', jsonb_build_object('passed', true, 'failures', '[]'::jsonb, 'missing_read_article_ids', '[]'::jsonb, 'accepted_as_no_signal_batch', true, 'server_processed_article_ids', true, 'note', 'Evidence-bearing no-signal result accepted. Model-reported read IDs were retained separately; canonical read IDs are the server-supplied batch IDs.'), true);
  new.status := 'completed'; new.finished_at := coalesce(new.finished_at, now()); new.updated_at := now(); new.next_retry_at := null; new.last_error_class := null; new.error_message := null; return new;
end;
$$;

create or replace function public.sanitize_full_corpus_scan_evidence_ids()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  allowed_ids text[]; cleaned_ids text[]; cleaned_evidence jsonb; reported_read_ids jsonb; has_evidence boolean; has_signal boolean; content_valid boolean;
begin
  select coalesce(array_agg(value::text), '{}'::text[]) into allowed_ids from unnest(coalesce(new.article_ids, '{}'::uuid[])) value;
  select coalesce(array_agg(distinct value order by value), '{}'::text[]) into cleaned_ids from unnest(coalesce(new.evidence_article_ids, '{}'::text[])) value where value = any(allowed_ids);
  new.evidence_article_ids := cleaned_ids;
  if jsonb_typeof(new.summary_json -> 'evidence') = 'array' then
    select coalesce(jsonb_agg(item), '[]'::jsonb) into cleaned_evidence from jsonb_array_elements(new.summary_json -> 'evidence') item where coalesce(item ->> 'article_id', item ->> 'id', '') = any(allowed_ids);
    new.summary_json := jsonb_set(coalesce(new.summary_json, '{}'::jsonb), '{evidence}', cleaned_evidence, true);
  end if;
  reported_read_ids := case when jsonb_typeof(new.summary_json -> 'read_article_ids') = 'array' then new.summary_json -> 'read_article_ids' else '[]'::jsonb end;
  has_evidence := jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'evidence') = 'array' then new.summary_json -> 'evidence' else '[]'::jsonb end) > 0;
  has_signal := jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'consumer_narratives') = 'array' then new.summary_json -> 'consumer_narratives' else '[]'::jsonb end) > 0 or jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'behavior_signals') = 'array' then new.summary_json -> 'behavior_signals' else '[]'::jsonb end) > 0 or jsonb_array_length(case when jsonb_typeof(new.summary_json -> 'weak_signals') = 'array' then new.summary_json -> 'weak_signals' else '[]'::jsonb end) > 0;
  content_valid := lower(coalesce(new.summary_json ->> 'analysis_is_validated', 'false')) in ('true', '1', 'yes') and lower(coalesce(new.summary_json ->> 'fallback_used', 'false')) not in ('true', '1', 'yes') and has_evidence and has_signal;
  if new.status in ('queued', 'needs_review') and coalesce(new.last_error_class, '') = 'validation' and coalesce(new.error_message, '') ~ '^read_article_ids missing [0-9]+ article\(s\)$' and content_valid then
    new.summary_json := jsonb_set(coalesce(new.summary_json, '{}'::jsonb), '{model_reported_read_article_ids}', reported_read_ids, true);
    new.summary_json := jsonb_set(new.summary_json, '{read_article_ids}', to_jsonb(allowed_ids), true);
    new.summary_json := jsonb_set(new.summary_json, '{server_processed_article_ids}', to_jsonb(allowed_ids), true);
    new.summary_json := jsonb_set(new.summary_json, '{validation}', jsonb_build_object('passed', true, 'failures', '[]'::jsonb, 'missing_read_article_ids', '[]'::jsonb, 'server_processed_article_ids', true, 'note', 'Model UUID echo mismatch was retained for audit; canonical read IDs are the server-supplied batch IDs.'), true);
    new.status := 'completed'; new.error_message := null; new.last_error_class := null; new.next_retry_at := null; new.finished_at := coalesce(new.finished_at, now());
  end if;
  return new;
end;
$$;

create or replace function public.full_corpus_run_integrity_v1(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.full_corpus_scan_runs r join public.corpus_scan_gate_view g on g.id = r.id
    where r.id = p_run_id and g.full_corpus_gate = 'passed' and r.status = 'completed' and r.total_batches > 0 and r.completed_batches = r.total_batches and r.failed_batches = 0 and r.needs_review_batches = 0 and r.analyzed_article_count = r.ocr_ready_article_count and r.ocr_ready_article_count = r.active_article_count
      and (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id) = r.total_batches
      and not exists (
        select 1 from public.full_corpus_scan_batches b where b.run_id = r.id and (
          b.status <> 'completed' or b.prompt_version <> 'full_corpus_batch_v2' or lower(coalesce(b.summary_json ->> 'analysis_is_validated', 'false')) not in ('true', '1', 'yes') or lower(coalesce(b.summary_json ->> 'fallback_used', 'false')) in ('true', '1', 'yes') or cardinality(b.article_ids) <> b.article_count
          or array(select article_id::text from unnest(b.article_ids) article_id order by article_id::text) <> array(select value from jsonb_array_elements_text(case when jsonb_typeof(b.summary_json -> 'read_article_ids') = 'array' then b.summary_json -> 'read_article_ids' else '[]'::jsonb end) value order by value)
          or jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'evidence') = 'array' then b.summary_json -> 'evidence' else '[]'::jsonb end) = 0
          or (lower(coalesce(b.summary_json ->> 'no_signal_detected', b.summary_json ->> 'no_signal_batch', 'false')) not in ('true', '1', 'yes') and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'consumer_narratives') = 'array' then b.summary_json -> 'consumer_narratives' else '[]'::jsonb end) = 0 and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'behavior_signals') = 'array' then b.summary_json -> 'behavior_signals' else '[]'::jsonb end) = 0 and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'weak_signals') = 'array' then b.summary_json -> 'weak_signals' else '[]'::jsonb end) = 0 and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'constraints') = 'array' then b.summary_json -> 'constraints' else '[]'::jsonb end) = 0 and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'contradictions') = 'array' then b.summary_json -> 'contradictions' else '[]'::jsonb end) = 0)
        )
      )
      and not exists (select 1 from public.full_corpus_scan_batches b cross join lateral unnest(b.article_ids) article_id left join public.formal_corpus_articles_v1 a on a.id = article_id where b.run_id = r.id and a.id is null)
      and (select count(*) from public.full_corpus_scan_batches b cross join lateral unnest(b.article_ids) article_id where b.run_id = r.id) = r.active_article_count
      and (select count(distinct article_id) from public.full_corpus_scan_batches b cross join lateral unnest(b.article_ids) article_id where b.run_id = r.id) = r.active_article_count
  );
$$;

revoke all on function public.accept_validated_no_signal_scan_batch() from public, anon, authenticated;
revoke all on function public.sanitize_full_corpus_scan_evidence_ids() from public, anon, authenticated;
revoke all on function public.full_corpus_run_integrity_v1(uuid) from public, anon, authenticated;
grant execute on function public.accept_validated_no_signal_scan_batch() to postgres, service_role;
grant execute on function public.sanitize_full_corpus_scan_evidence_ids() to postgres, service_role;
grant execute on function public.full_corpus_run_integrity_v1(uuid) to postgres, service_role;
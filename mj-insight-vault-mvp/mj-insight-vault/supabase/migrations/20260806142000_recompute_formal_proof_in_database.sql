-- Formal classification must be recomputed from persisted run and evidence data.
-- Do not trust an application-supplied quality status on its own.

create or replace function public.full_corpus_run_integrity_v1(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.full_corpus_scan_runs r
    join public.corpus_scan_gate_view g on g.id = r.id
    where r.id = p_run_id
      and g.full_corpus_gate = 'passed'
      and r.status = 'completed'
      and r.total_batches > 0
      and r.completed_batches = r.total_batches
      and r.failed_batches = 0
      and r.needs_review_batches = 0
      and r.analyzed_article_count = r.ocr_ready_article_count
      and r.ocr_ready_article_count = r.active_article_count
      and (
        select count(*)
        from public.full_corpus_scan_batches b
        where b.run_id = r.id
      ) = r.total_batches
      and not exists (
        select 1
        from public.full_corpus_scan_batches b
        where b.run_id = r.id
          and (
            b.status <> 'completed'
            or b.prompt_version <> 'full_corpus_batch_v2'
            or lower(coalesce(b.summary_json ->> 'analysis_is_validated', 'false')) not in ('true', '1', 'yes')
            or lower(coalesce(b.summary_json ->> 'fallback_used', 'false')) in ('true', '1', 'yes')
            or cardinality(b.article_ids) <> b.article_count
            or array(
              select article_id::text
              from unnest(b.article_ids) article_id
              order by article_id::text
            ) <> array(
              select value
              from jsonb_array_elements_text(
                case
                  when jsonb_typeof(b.summary_json -> 'read_article_ids') = 'array'
                    then b.summary_json -> 'read_article_ids'
                  else '[]'::jsonb
                end
              ) value
              order by value
            )
            or jsonb_array_length(
              case
                when jsonb_typeof(b.summary_json -> 'evidence') = 'array'
                  then b.summary_json -> 'evidence'
                else '[]'::jsonb
              end
            ) = 0
            or (
              lower(coalesce(b.summary_json ->> 'no_signal_detected', 'false')) not in ('true', '1', 'yes')
              and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'consumer_narratives') = 'array' then b.summary_json -> 'consumer_narratives' else '[]'::jsonb end) = 0
              and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'behavior_signals') = 'array' then b.summary_json -> 'behavior_signals' else '[]'::jsonb end) = 0
              and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'weak_signals') = 'array' then b.summary_json -> 'weak_signals' else '[]'::jsonb end) = 0
              and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'constraints') = 'array' then b.summary_json -> 'constraints' else '[]'::jsonb end) = 0
              and jsonb_array_length(case when jsonb_typeof(b.summary_json -> 'contradictions') = 'array' then b.summary_json -> 'contradictions' else '[]'::jsonb end) = 0
            )
          )
      )
      and not exists (
        select 1
        from public.full_corpus_scan_batches b
        cross join lateral unnest(b.article_ids) article_id
        left join public.formal_corpus_articles_v1 a on a.id = article_id
        where b.run_id = r.id
          and a.id is null
      )
      and (
        select count(*)
        from public.full_corpus_scan_batches b
        cross join lateral unnest(b.article_ids) article_id
        where b.run_id = r.id
      ) = r.active_article_count
      and (
        select count(distinct article_id)
        from public.full_corpus_scan_batches b
        cross join lateral unnest(b.article_ids) article_id
        where b.run_id = r.id
      ) = r.active_article_count
  );
$$;

create or replace function public.report_raw_evidence_integrity_v1(
  p_payload jsonb,
  p_run_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with evidence_items as (
    select item
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_payload -> 'evidence_matrix') = 'array'
          then p_payload -> 'evidence_matrix'
        else '[]'::jsonb
      end
    ) item
  ),
  valid_evidence as (
    select coalesce(item ->> 'article_id', item ->> 'id') as article_id
    from evidence_items
    where jsonb_typeof(item) = 'object'
      and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
      and coalesce(item ->> 'article_id', item ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and length(btrim(coalesce(
        item ->> 'evidence_excerpt_or_fact',
        item ->> 'evidence_excerpt',
        item ->> 'observed_fact',
        item ->> 'excerpt',
        ''
      ))) >= 20
      and exists (
        select 1
        from public.formal_corpus_articles_v1 a
        where a.id = coalesce(item ->> 'article_id', item ->> 'id')::uuid
      )
      and exists (
        select 1
        from public.full_corpus_scan_batches b
        where b.run_id = p_run_id
          and coalesce(item ->> 'article_id', item ->> 'id')::uuid = any(b.article_ids)
      )
  )
  select
    (select count(distinct article_id) from valid_evidence) >= 3
    and exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_payload -> 'refutation_audit') = 'array' then p_payload -> 'refutation_audit' else '[]'::jsonb end
      ) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
    )
    and exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_payload -> 'research_needs') = 'array' then p_payload -> 'research_needs' else '[]'::jsonb end
      ) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
    )
    and exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_payload -> 'negative_space') = 'array' then p_payload -> 'negative_space' else '[]'::jsonb end
      ) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
    )
    and exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_payload -> 'confidence_rubric') = 'array' then p_payload -> 'confidence_rubric' else '[]'::jsonb end
      ) item
      where jsonb_typeof(item) = 'object'
        and lower(coalesce(item ->> 'synthetic_repair', 'false')) not in ('true', '1', 'yes')
    );
$$;

revoke all on function public.full_corpus_run_integrity_v1(uuid) from public, anon, authenticated;
revoke all on function public.report_raw_evidence_integrity_v1(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.full_corpus_run_integrity_v1(uuid) to postgres, service_role;
grant execute on function public.report_raw_evidence_integrity_v1(jsonb, uuid) to postgres, service_role;

create or replace function public.sync_chat_report_metadata()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  payload jsonb := coalesce(new.answer_json, '{}'::jsonb);
  gate text := coalesce(payload ->> 'full_corpus_gate', payload #>> '{source_coverage,full_corpus_gate}', 'failed');
  integrity_gate text := coalesce(payload ->> 'full_corpus_integrity_gate', payload #>> '{source_coverage,full_corpus_integrity_gate}', 'failed');
  prompt_version text := coalesce(payload ->> 'full_corpus_prompt_version', payload #>> '{source_coverage,full_corpus_prompt_version}', '');
  all_batches_represented boolean := lower(coalesce(
    payload ->> 'final_context_all_batches_represented',
    payload #>> '{source_coverage,final_context_all_batches_represented}',
    'false'
  )) in ('true', '1', 'yes');
  omitted_text text := coalesce(payload ->> 'final_context_omitted_batches', payload #>> '{source_coverage,final_context_omitted_batches}', '0');
  represented_batches_text text := coalesce(payload ->> 'final_context_represented_batches', payload #>> '{source_coverage,final_context_represented_batches}', '0');
  represented_articles_text text := coalesce(payload ->> 'final_context_represented_article_count', payload #>> '{source_coverage,final_context_represented_article_count}', '0');
  omitted_batches integer := 0;
  represented_batches integer := 0;
  represented_articles integer := 0;
  quality_status text := coalesce(payload #>> '{quality_gate,status}', '');
  gate_version text := coalesce(payload ->> 'formal_gate_version', payload #>> '{raw_quality_gate,version}', '');
  validation_mode text := coalesce(payload #>> '{raw_quality_gate,validation_mode}', '');
  generation_status_value text := coalesce(nullif(payload ->> 'generation_status', ''), 'completed');
  report_kind_value text := coalesce(payload ->> 'report_kind', '');
  generation_warning text := lower(coalesce(payload ->> 'generation_warning', ''));
  report_chat boolean := lower(coalesce(payload ->> 'report_chat', 'false')) in ('true', '1', 'yes');
  provisional boolean := lower(coalesce(
    payload ->> 'analysis_is_provisional',
    payload #>> '{source_coverage,analysis_is_provisional}',
    payload #>> '{coverage_diagnosis,analysis_is_provisional}',
    'false'
  )) in ('true', '1', 'yes');
  blocked boolean := generation_status_value = 'blocked'
    or report_kind_value = 'diagnostic'
    or report_chat;
  fallback_used boolean := generation_warning like '%emergency_fallback%'
    or generation_warning like '%extractive_fallback%'
    or generation_warning like '%openai_api_key missing%'
    or lower(coalesce(payload ->> 'fallback_used', 'false')) in ('true', '1', 'yes');
  full_corpus_candidate boolean := gate = 'passed' and not blocked;
  run_id_text text := coalesce(payload ->> 'full_corpus_run_id', payload #>> '{source_coverage,full_corpus_run_id}', '');
  run_id uuid;
  metadata_integrity boolean;
  database_run_integrity boolean := false;
  database_raw_integrity boolean := false;
  formal boolean;
begin
  if omitted_text ~ '^\d+$' then omitted_batches := omitted_text::integer; end if;
  if represented_batches_text ~ '^\d+$' then represented_batches := represented_batches_text::integer; end if;
  if represented_articles_text ~ '^\d+$' then represented_articles := represented_articles_text::integer; end if;

  if run_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    run_id := run_id_text::uuid;
  end if;

  metadata_integrity := integrity_gate = 'passed'
    and prompt_version = 'full_corpus_batch_v2'
    and all_batches_represented
    and omitted_batches = 0
    and represented_batches > 0
    and represented_articles > 0;

  if run_id is not null then
    database_run_integrity := public.full_corpus_run_integrity_v1(run_id);
    database_raw_integrity := public.report_raw_evidence_integrity_v1(payload, run_id);
  end if;

  formal := full_corpus_candidate
    and metadata_integrity
    and database_run_integrity
    and database_raw_integrity
    and new.source_job_id is not null
    and gate_version = 'formal_gate_v2'
    and validation_mode = 'raw_before_enrichment'
    and quality_status = 'passed'
    and not provisional
    and not fallback_used;

  if tg_op = 'INSERT'
    and full_corpus_candidate
    and gate_version <> 'formal_gate_v2' then
    raise exception using
      errcode = '23514',
      message = 'formal_report_gate_version_missing',
      detail = 'A full-corpus report must pass formal_gate_v2 before persistence.';
  end if;

  if tg_op = 'INSERT'
    and full_corpus_candidate
    and not metadata_integrity then
    raise exception using
      errcode = '23514',
      message = 'formal_report_integrity_gate_missing',
      detail = 'A formal report requires full_corpus_batch_v2 and an all-batch final context with zero omissions.';
  end if;

  if tg_op = 'INSERT'
    and full_corpus_candidate
    and not database_run_integrity then
    raise exception using
      errcode = '23514',
      message = 'formal_report_run_integrity_failed',
      detail = 'The referenced scan run does not pass database-recomputed v2 batch integrity.';
  end if;

  if tg_op = 'INSERT'
    and full_corpus_candidate
    and not database_raw_integrity then
    raise exception using
      errcode = '23514',
      message = 'formal_report_raw_evidence_integrity_failed',
      detail = 'The raw report evidence does not pass database-recomputed evidence integrity.';
  end if;

  if tg_op = 'INSERT'
    and full_corpus_candidate
    and new.source_job_id is null then
    raise exception using
      errcode = '23514',
      message = 'formal_report_source_job_missing',
      detail = 'Formal reports must be linked to a durable report job.';
  end if;

  new.full_corpus_gate := gate;
  new.is_formal_report := formal;
  new.generation_status := generation_status_value;
  new.report_kind := case
    when report_kind_value = 'diagnostic' or new.generation_status = 'blocked' then 'diagnostic'
    when report_chat then 'followup'
    when formal then 'formal'
    else 'provisional'
  end;
  new.analysis_verification_status := case
    when formal then 'full_corpus_verified'
    when new.report_kind = 'followup' then 'derived_followup'
    when new.report_kind = 'diagnostic' then 'blocked_diagnostic'
    when not metadata_integrity and full_corpus_candidate then 'integrity_unverified'
    when not database_run_integrity and full_corpus_candidate then 'run_integrity_unverified'
    when not database_raw_integrity and full_corpus_candidate then 'raw_evidence_unverified'
    when new.source_job_id is null and full_corpus_candidate then 'source_job_unverified'
    when provisional then 'provisional_unverified'
    when fallback_used then 'fallback_unverified'
    when gate_version <> 'formal_gate_v2' then 'gate_version_unverified'
    else 'quality_unverified'
  end;
  return new;
end;
$$;

-- Recompute existing classification without granting formal status to legacy rows.
update public.chat_reports
set answer_json = answer_json
where full_corpus_gate = 'passed'
   or is_formal_report = true;

-- Requeue only missing or stale v2 category classifications.
-- The category gate requires article_profiles/article_category_memberships to
-- match formal_corpus_articles_v1.analysis_text_sha256. The original enqueue
-- function ignored stale source hashes unless p_force=true, which would requeue
-- every completed job and cause avoidable LLM spend.

create or replace function public.enqueue_article_classification_v2(
  p_force boolean default false,
  p_model text default 'gpt-4o-mini'::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_model text := coalesce(nullif(btrim(p_model), ''), 'gpt-4o-mini');
  v_inserted integer := 0;
  v_requeued integer := 0;
begin
  insert into public.article_classification_jobs(
    article_id,
    status,
    classifier_version,
    model,
    attempt_count,
    next_retry_at,
    lease_token,
    lease_expires_at,
    heartbeat_at,
    result_json,
    error_message,
    updated_at,
    finished_at
  )
  select
    a.id,
    'queued',
    'article_category_profile_v2',
    v_model,
    0,
    null,
    null,
    null,
    null,
    '{}'::jsonb,
    null,
    now(),
    null
  from public.formal_corpus_articles_v1 a
  where
    p_force
    or not exists (
      select 1
      from public.article_profiles p
      where p.article_id = a.id
        and p.profile_model = 'article_category_profile_v2'
        and p.source_analysis_text_sha256 = a.analysis_text_sha256
    )
    or not exists (
      select 1
      from public.article_category_memberships m
      where m.article_id = a.id
        and m.source = 'article_category_profile_v2'
        and m.source_analysis_text_sha256 = a.analysis_text_sha256
    )
  on conflict(article_id, classifier_version) do nothing;
  get diagnostics v_inserted = row_count;

  if p_force then
    update public.article_classification_jobs j
    set
      status = 'queued',
      model = v_model,
      attempt_count = 0,
      next_retry_at = null,
      lease_token = null,
      lease_expires_at = null,
      heartbeat_at = null,
      result_json = '{}'::jsonb,
      error_message = null,
      updated_at = now(),
      finished_at = null
    where j.classifier_version = 'article_category_profile_v2'
      and j.status <> 'running';
    get diagnostics v_requeued = row_count;
  else
    update public.article_classification_jobs j
    set
      status = 'queued',
      model = v_model,
      next_retry_at = null,
      lease_token = null,
      lease_expires_at = null,
      heartbeat_at = null,
      error_message = null,
      updated_at = now(),
      finished_at = null
    from public.formal_corpus_articles_v1 a
    where j.article_id = a.id
      and j.classifier_version = 'article_category_profile_v2'
      and j.status in ('completed', 'failed')
      and (
        not exists (
          select 1
          from public.article_profiles p
          where p.article_id = a.id
            and p.profile_model = 'article_category_profile_v2'
            and p.source_analysis_text_sha256 = a.analysis_text_sha256
        )
        or not exists (
          select 1
          from public.article_category_memberships m
          where m.article_id = a.id
            and m.source = 'article_category_profile_v2'
            and m.source_analysis_text_sha256 = a.analysis_text_sha256
        )
      );
    get diagnostics v_requeued = row_count;
  end if;

  return jsonb_build_object(
    'classifier_version', 'article_category_profile_v2',
    'inserted_jobs', v_inserted,
    'requeued_jobs', v_requeued,
    'formal_article_count', (select count(*) from public.formal_corpus_articles_v1),
    'queued_count', (
      select count(*)
      from public.article_classification_jobs
      where classifier_version = 'article_category_profile_v2'
        and status = 'queued'
    )
  );
end;
$function$;

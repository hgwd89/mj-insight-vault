-- Reconcile the report-analysis schema used by the application.
-- The application accesses these tables only through the server-side service role.

create extension if not exists pgcrypto;

create table if not exists public.article_profiles (
  article_id uuid primary key references public.articles(id) on delete cascade,
  profile_model text not null default 'rule_based_v1',
  primary_category text,
  secondary_categories text[] not null default '{}',
  consumer_scene text,
  market_signal text,
  product_type text,
  consumer_need text,
  confidence numeric,
  reason text,
  profile_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.analysis_categories (
  id text primary key,
  name_ja text not null,
  parent_id text references public.analysis_categories(id),
  description text,
  keywords text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.article_category_memberships (
  article_id uuid not null references public.articles(id) on delete cascade,
  category_id text not null references public.analysis_categories(id) on delete cascade,
  score numeric not null default 0,
  confidence numeric not null default 0,
  source text not null default 'rule_based_v1',
  match_terms text[] not null default '{}',
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (article_id, category_id)
);

create index if not exists article_category_memberships_category_idx
  on public.article_category_memberships(category_id, score desc);

create table if not exists public.full_corpus_scan_runs (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null default 'all',
  scope_query text,
  status text not null default 'queued',
  model text not null default 'gpt-4o-mini',
  batch_size integer not null default 30,
  active_article_count integer not null default 0,
  ocr_ready_article_count integer not null default 0,
  total_batches integer not null default 0,
  completed_batches integer not null default 0,
  failed_batches integer not null default 0,
  analyzed_article_count integer not null default 0,
  needs_review_batches integer not null default 0,
  coverage_json jsonb not null default '{}',
  synthesis_json jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.full_corpus_scan_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.full_corpus_scan_runs(id) on delete cascade,
  batch_index integer not null,
  article_ids uuid[] not null default '{}',
  article_count integer not null default 0,
  status text not null default 'queued',
  model text not null default 'gpt-4o-mini',
  prompt_version text not null default 'full_corpus_batch_v1',
  summary_json jsonb,
  evidence_article_ids uuid[] not null default '{}',
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, batch_index)
);

create index if not exists full_corpus_scan_runs_scope_created_idx
  on public.full_corpus_scan_runs(scope_type, scope_query, created_at desc);
create index if not exists full_corpus_scan_runs_status_idx
  on public.full_corpus_scan_runs(status);
create index if not exists full_corpus_scan_batches_run_status_idx
  on public.full_corpus_scan_batches(run_id, status, batch_index);

create or replace function public.touch_full_corpus_scan_run()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  update public.full_corpus_scan_runs r
  set updated_at = now(),
      completed_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'completed'),
      failed_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'failed'),
      needs_review_batches = (select count(*) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'needs_review'),
      analyzed_article_count = coalesce((select sum(article_count) from public.full_corpus_scan_batches b where b.run_id = r.id and b.status = 'completed'), 0)
  where r.id = new.run_id;
  return new;
end;
$$;

drop trigger if exists trg_touch_full_corpus_scan_run on public.full_corpus_scan_batches;
create trigger trg_touch_full_corpus_scan_run
after insert or update on public.full_corpus_scan_batches
for each row execute function public.touch_full_corpus_scan_run();

-- Hidden DB completion made job state depend on a report insert instead of the job runner.
-- The application runner is the only owner of chat_jobs status transitions.
drop trigger if exists trg_auto_complete_chat_job_when_report_saved on public.chat_jobs;

insert into public.analysis_categories (id, name_ja, description, keywords)
values
  ('beauty_cosmetics', '化粧品・美容', '化粧品、美容、セルフケア', array['化粧品','美容','コスメ','スキンケア','メイク']),
  ('food_beverage', '食品・飲料', '食品、飲料、外食', array['食品','飲料','食','外食','フード']),
  ('retail_channel', '小売・流通・店頭', '小売、流通、売場、店頭', array['小売','流通','店頭','売場','店舗','EC']),
  ('health_wellness', '健康・ウェルネス', '健康、医療、ウェルネス', array['健康','医療','ヘルスケア','ウェルネス']),
  ('digital_ai', 'デジタル・AI・アプリ', 'デジタルサービス、AI、アプリ', array['AI','生成AI','デジタル','アプリ','オンライン']),
  ('fashion_apparel', 'ファッション・アパレル', '衣料、服飾、ファッション', array['ファッション','衣料','アパレル','服']),
  ('household_daily', '日用品・家庭生活', '日用品、家事、家庭生活', array['日用品','家庭','家事','生活用品']),
  ('mobility_travel', '移動・旅行・レジャー', '移動、旅行、レジャー', array['旅行','観光','交通','移動','レジャー']),
  ('finance_value', '価格・節約・金融', '価格、節約、金融、価値', array['価格','節約','金融','値上げ','コスパ']),
  ('sustainability', '環境・サステナビリティ', '環境、循環、サステナビリティ', array['環境','サステナビリティ','脱炭素','循環']),
  ('youth_sns', '若者・Z世代・SNS文化', '若者、SNS、Z世代', array['若者','Z世代','SNS','インフルエンサー']),
  ('senior_family', 'シニア・家族・ライフステージ', 'シニア、家族、ライフステージ', array['シニア','家族','子育て','ライフステージ']),
  ('experience_personalization', '体験・診断・パーソナライズ', '体験、診断、個別化', array['体験','診断','パーソナライズ','個別化'])
on conflict (id) do nothing;

create or replace view public.corpus_scan_gate_view as
with current_all as (
  select count(*)::integer as current_article_count
  from public.articles a
  where (a.status is null or a.status not in ('deleted','excluded','rejected'))
    and coalesce(a.ocr_text, '') <> ''
), current_category as (
  select m.category_id, count(distinct a.id)::integer as current_article_count
  from public.article_category_memberships m
  join public.articles a on a.id = m.article_id
  where (a.status is null or a.status not in ('deleted','excluded','rejected'))
    and coalesce(a.ocr_text, '') <> ''
  group by m.category_id
)
select r.id, r.scope_type, r.scope_query, r.status, r.model, r.active_article_count,
  case when r.scope_type = 'all' then ca.current_article_count
       when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
       else r.active_article_count end as current_article_count,
  (case when r.scope_type = 'all' then ca.current_article_count
        when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
        else r.active_article_count end - r.active_article_count) as current_article_count_diff,
  r.ocr_ready_article_count, r.total_batches, r.completed_batches, r.failed_batches,
  r.needs_review_batches, r.analyzed_article_count,
  case when r.status = 'completed' and r.total_batches > 0
        and r.completed_batches = r.total_batches and r.failed_batches = 0
        and r.needs_review_batches = 0 and r.analyzed_article_count = r.ocr_ready_article_count
        and r.ocr_ready_article_count = r.active_article_count
        and (case when r.scope_type = 'all' then ca.current_article_count
                  when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
                  else r.active_article_count end) = r.active_article_count
       then 'passed' else 'failed' end as full_corpus_gate,
  case when r.active_article_count = 0 then 'no_articles'
       when (case when r.scope_type = 'all' then ca.current_article_count
                  when r.scope_type = 'category' then coalesce(cc.current_article_count, 0)
                  else r.active_article_count end) <> r.active_article_count then 'run_stale_article_count_mismatch'
       when r.ocr_ready_article_count <> r.active_article_count then 'ocr_incomplete'
       when r.total_batches = 0 then 'no_batches'
       when r.completed_batches <> r.total_batches then 'batches_incomplete'
       when r.failed_batches > 0 then 'failed_batches_exist'
       when r.needs_review_batches > 0 then 'needs_review_batches_exist'
       when r.analyzed_article_count <> r.ocr_ready_article_count then 'analyzed_count_mismatch'
       when r.status <> 'completed' then 'run_not_completed'
       else 'passed' end as gate_reason,
  r.created_at, r.updated_at, r.finished_at
from public.full_corpus_scan_runs r
cross join current_all ca
left join current_category cc on cc.category_id = r.scope_query;

create or replace view public.category_analysis_readiness_view as
with category_counts as (
  select c.id as category_id, c.name_ja, c.description, count(m.article_id) as matched_article_count
  from public.analysis_categories c
  left join public.article_category_memberships m on m.category_id = c.id
  where c.is_active = true
  group by c.id, c.name_ja, c.description
), latest_runs as (
  select distinct on (r.scope_query) r.scope_query as category_id, r.id as run_id, r.status,
    r.active_article_count, r.ocr_ready_article_count, r.total_batches, r.completed_batches,
    r.failed_batches, r.needs_review_batches, r.analyzed_article_count, r.created_at, r.updated_at,
    case when r.status = 'completed' and r.total_batches > 0 and r.completed_batches = r.total_batches
      and r.failed_batches = 0 and r.needs_review_batches = 0
      and r.analyzed_article_count = r.ocr_ready_article_count
      and r.ocr_ready_article_count = r.active_article_count then 'passed' else 'failed' end as category_full_corpus_gate
  from public.full_corpus_scan_runs r
  where r.scope_type = 'category'
  order by r.scope_query, r.created_at desc
)
select cc.category_id, cc.name_ja, cc.description, cc.matched_article_count,
  lr.run_id, coalesce(lr.status, 'not_created') as run_status,
  coalesce(lr.active_article_count, 0) as run_article_count,
  coalesce(lr.ocr_ready_article_count, 0) as ocr_ready_article_count,
  coalesce(lr.total_batches, 0) as total_batches,
  coalesce(lr.completed_batches, 0) as completed_batches,
  coalesce(lr.failed_batches, 0) as failed_batches,
  coalesce(lr.needs_review_batches, 0) as needs_review_batches,
  coalesce(lr.analyzed_article_count, 0) as analyzed_article_count,
  coalesce(lr.category_full_corpus_gate, 'failed') as category_full_corpus_gate,
  case when cc.matched_article_count = 0 then 'no_articles'
       when lr.run_id is null then 'scan_run_missing'
       when lr.active_article_count <> cc.matched_article_count then 'run_article_count_mismatch'
       when lr.total_batches = 0 then 'no_batches'
       when lr.completed_batches <> lr.total_batches then 'batches_incomplete'
       when lr.failed_batches > 0 then 'failed_batches_exist'
       when lr.needs_review_batches > 0 then 'needs_review_batches_exist'
       when lr.analyzed_article_count <> lr.ocr_ready_article_count then 'analyzed_count_mismatch'
       when lr.category_full_corpus_gate = 'passed' then 'passed'
       else 'failed' end as readiness_reason,
  lr.created_at as run_created_at, lr.updated_at as run_updated_at
from category_counts cc left join latest_runs lr on lr.category_id = cc.category_id;

create or replace view public.corpus_scan_execution_priority_view as
select id as run_id, scope_type, scope_query, status, active_article_count, current_article_count,
  current_article_count_diff, ocr_ready_article_count, total_batches, completed_batches,
  failed_batches, needs_review_batches, analyzed_article_count, full_corpus_gate, gate_reason,
  case when gate_reason = 'run_stale_article_count_mismatch' then 999999
       when scope_type = 'all' then 100000
       when scope_query = 'beauty_cosmetics' then 90000
       when scope_query = 'retail_channel' then 80000
       when scope_query = 'food_beverage' then 70000
       when scope_query = 'finance_value' then 65000 else 50000 end
    + active_article_count - (completed_batches * 10) - (failed_batches * 100) - (needs_review_batches * 100) as priority_score,
  case when full_corpus_gate = 'passed' then 'done'
       when gate_reason = 'run_stale_article_count_mismatch' then 'stale_rebuild_required'
       when failed_batches > 0 or needs_review_batches > 0 then 'review_or_retry'
       when completed_batches = 0 then 'not_started' else 'in_progress' end as execution_state,
  created_at, updated_at
from public.corpus_scan_gate_view
where full_corpus_gate <> 'passed';

alter table public.article_profiles enable row level security;
alter table public.analysis_categories enable row level security;
alter table public.article_category_memberships enable row level security;
alter table public.full_corpus_scan_runs enable row level security;
alter table public.full_corpus_scan_batches enable row level security;
revoke all on table public.article_profiles, public.analysis_categories, public.article_category_memberships, public.full_corpus_scan_runs, public.full_corpus_scan_batches from anon, authenticated;

alter table public.chat_reports
  add column if not exists report_kind text not null default 'provisional',
  add column if not exists generation_status text not null default 'completed',
  add column if not exists is_formal_report boolean not null default false,
  add column if not exists analysis_verification_status text not null default 'provisional_unverified',
  add column if not exists full_corpus_gate text not null default 'failed';

create or replace function public.sanitize_report_text(input_text text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  marker text;
  marker_position integer;
  cut_position integer := coalesce(length(input_text), 0) + 1;
  cleaned text := replace(coalesce(input_text, ''), E'\r\n', E'\n');
begin
  foreach marker in array array[
    E'\n\n【レポート要件】',
    E'\n\n[レポート要件]'
  ] loop
    marker_position := strpos(cleaned, marker);
    if marker_position > 0 and marker_position < cut_position then
      cut_position := marker_position;
    end if;
  end loop;

  if cut_position <= length(cleaned) then
    cleaned := left(cleaned, cut_position - 1);
  end if;

  cleaned := regexp_replace(cleaned, '^\s*全記事を対象に、全データを広域スキャンしたうえで分析してください。[\s　]*', '', 'g');
  cleaned := regexp_replace(cleaned, '^\s*MJ記事群から生活者動向を読み、説明仮説・根拠・調査が必要そうな論点を抽出します。[\s　]*', '', 'g');
  cleaned := regexp_replace(cleaned, E'\n{3,}', E'\n\n', 'g');
  return btrim(cleaned);
end;
$$;

create or replace function public.sanitize_report_json(input_json jsonb)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  if input_json is null then
    return '{}'::jsonb;
  end if;

  if jsonb_typeof(input_json) = 'object' then
    select coalesce(
      jsonb_object_agg(key, public.sanitize_report_json(value)),
      '{}'::jsonb
    )
    into result
    from jsonb_each(input_json)
    where key not in (
      'report_requirements',
      'quality_instructions',
      'system_prompt',
      'analysis_instruction',
      'prompt',
      'messages'
    );
    return result;
  end if;

  if jsonb_typeof(input_json) = 'array' then
    select coalesce(
      jsonb_agg(public.sanitize_report_json(value)),
      '[]'::jsonb
    )
    into result
    from jsonb_array_elements(input_json);
    return result;
  end if;

  if jsonb_typeof(input_json) = 'string' then
    return to_jsonb(public.sanitize_report_text(input_json #>> '{}'));
  end if;

  return input_json;
end;
$$;

update public.chat_reports
set
  user_query = public.sanitize_report_text(user_query),
  answer_text = public.sanitize_report_text(answer_text),
  answer_json = public.sanitize_report_json(coalesce(answer_json, '{}'::jsonb)),
  report_kind = case
    when coalesce(answer_json ->> 'report_kind', '') = 'diagnostic' then 'diagnostic'
    when coalesce(answer_json ->> 'report_kind', '') = 'followup' then 'followup'
    else 'legacy'
  end,
  generation_status = case
    when coalesce(answer_json ->> 'generation_status', '') <> '' then answer_json ->> 'generation_status'
    else 'legacy'
  end,
  is_formal_report = false,
  analysis_verification_status = 'legacy_unverified',
  full_corpus_gate = case
    when coalesce(answer_json ->> 'full_corpus_gate', '') = 'passed' then 'passed'
    else 'failed'
  end;

create index if not exists chat_reports_verification_idx
  on public.chat_reports(is_formal_report, analysis_verification_status, created_at desc);

create or replace function public.sync_chat_report_metadata()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  payload jsonb := coalesce(new.answer_json, '{}'::jsonb);
  gate text := coalesce(payload ->> 'full_corpus_gate', 'failed');
  quality_status text := coalesce(payload #>> '{quality_gate,status}', '');
  formal boolean := gate = 'passed'
    and quality_status = 'passed'
    and coalesce(payload ->> 'generation_status', '') <> 'blocked';
begin
  new.full_corpus_gate := gate;
  new.is_formal_report := formal;
  new.generation_status := coalesce(nullif(payload ->> 'generation_status', ''), 'completed');
  new.report_kind := case
    when coalesce(payload ->> 'report_kind', '') = 'diagnostic'
      or new.generation_status = 'blocked' then 'diagnostic'
    when coalesce(payload ->> 'report_chat', '') = 'true' then 'followup'
    when formal then 'formal'
    else 'provisional'
  end;
  new.analysis_verification_status := case
    when formal then 'full_corpus_verified'
    when new.report_kind = 'followup' then 'derived_followup'
    when new.report_kind = 'diagnostic' then 'blocked_diagnostic'
    else 'provisional_unverified'
  end;
  return new;
end;
$$;

drop trigger if exists trg_sync_chat_report_metadata on public.chat_reports;
create trigger trg_sync_chat_report_metadata
before insert or update of answer_json on public.chat_reports
for each row execute function public.sync_chat_report_metadata();

drop view if exists public.analysis_readiness_view;
create view public.analysis_readiness_view as
with article_counts as (
  select
    count(*) filter (where a.status is null or a.status not in ('deleted','excluded','rejected'))::integer as active_article_count,
    count(*) filter (where (a.status is null or a.status not in ('deleted','excluded','rejected')) and coalesce(a.ocr_text, '') <> '')::integer as ocr_ready_article_count
  from public.articles a
), profile_counts as (
  select count(*)::integer as profiled_article_count
  from public.article_profiles p
  join public.articles a on a.id = p.article_id
  where (a.status is null or a.status not in ('deleted','excluded','rejected'))
)
select
  ac.active_article_count,
  ac.ocr_ready_article_count,
  pc.profiled_article_count,
  (select count(*)::integer from public.full_corpus_scan_runs where scope_type = 'all') as all_scan_run_count,
  (select count(*)::integer from public.full_corpus_scan_runs where scope_type = 'category') as category_scan_run_count,
  (select count(*)::integer from public.corpus_scan_gate_view where full_corpus_gate = 'passed') as passed_scan_count,
  (select count(*)::integer from public.corpus_scan_gate_view where full_corpus_gate = 'failed') as failed_scan_count,
  (select count(*)::integer from public.chat_reports) as report_count,
  (select count(*)::integer from public.chat_reports where is_formal_report = true and analysis_verification_status = 'full_corpus_verified' and full_corpus_gate = 'passed') as full_corpus_verified_report_count,
  case when ac.ocr_ready_article_count = ac.profiled_article_count then 'ready_for_scan_execution' else 'ocr_or_profile_incomplete' end as readiness_status
from article_counts ac cross join profile_counts;
do $$
begin
  if current_setting('server_version_num')::integer >= 150000 then
    execute 'alter view public.corpus_scan_gate_view set (security_invoker = true)';
    execute 'alter view public.category_analysis_readiness_view set (security_invoker = true)';
    execute 'alter view public.corpus_scan_execution_priority_view set (security_invoker = true)';
    execute 'alter view public.analysis_readiness_view set (security_invoker = true)';
  end if;
end;
$$;

revoke all on public.corpus_scan_gate_view, public.category_analysis_readiness_view, public.corpus_scan_execution_priority_view, public.analysis_readiness_view from anon, authenticated;

do $$
begin
  if to_regprocedure('public.auto_complete_chat_job_when_report_saved()') is not null then
    execute 'alter function public.auto_complete_chat_job_when_report_saved() set search_path = pg_catalog, public';
  end if;
end;
$$;

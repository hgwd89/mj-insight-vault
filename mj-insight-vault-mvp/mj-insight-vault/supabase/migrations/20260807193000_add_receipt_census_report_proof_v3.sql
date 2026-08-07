-- AAAA report proof v3: persist one grounded reading receipt per article and
-- a full-corpus theme census before any theme can be certified as major.
-- This migration is additive. The existing v1/v2 paths remain historical only.

create table if not exists public.full_corpus_article_receipts (
  run_id uuid not null references public.full_corpus_scan_runs(id) on delete cascade,
  batch_id uuid not null references public.full_corpus_scan_batches(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  article_analysis_sha256 text not null,
  grounded_excerpt text not null,
  observed_fact text not null,
  signal_class text not null check (signal_class in ('direct_consumer','market_signal_only','no_consumer_signal')),
  consumer_relevance text not null check (consumer_relevance in ('high','medium','low','none')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  model text not null,
  prompt_version text not null,
  receipt_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, article_id),
  unique (batch_id, article_id)
);

create index if not exists full_corpus_article_receipts_batch_idx
  on public.full_corpus_article_receipts(batch_id, article_id);
create index if not exists full_corpus_article_receipts_signal_idx
  on public.full_corpus_article_receipts(run_id, signal_class, consumer_relevance);

alter table public.full_corpus_article_receipts enable row level security;
revoke all on public.full_corpus_article_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.full_corpus_article_receipts to postgres, service_role;

create table if not exists public.full_corpus_theme_census_runs (
  id uuid primary key default gen_random_uuid(),
  scan_run_id uuid not null references public.full_corpus_scan_runs(id) on delete cascade,
  source_job_id uuid references public.chat_jobs(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  model text not null,
  prompt_version text not null default 'full_corpus_theme_census_v1',
  candidate_themes jsonb not null default '[]'::jsonb,
  expected_article_count integer not null default 0,
  candidate_theme_count integer not null default 0,
  completed_item_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (scan_run_id, source_job_id)
);

create index if not exists full_corpus_theme_census_runs_scan_idx
  on public.full_corpus_theme_census_runs(scan_run_id, status, updated_at desc);

alter table public.full_corpus_theme_census_runs enable row level security;
revoke all on public.full_corpus_theme_census_runs from public, anon, authenticated;
grant select, insert, update, delete on public.full_corpus_theme_census_runs to postgres, service_role;

create table if not exists public.full_corpus_theme_census_items (
  census_run_id uuid not null references public.full_corpus_theme_census_runs(id) on delete cascade,
  theme_id text not null,
  article_id uuid not null references public.articles(id) on delete cascade,
  batch_index integer not null,
  relation text not null check (relation in ('support','counter','related_not_supporting','none')),
  evidence_type text not null check (evidence_type in ('consumer_survey','purchase_behavior','usage_behavior','consumer_quote','supply_signal','none')),
  grounded_excerpt text not null,
  rationale text not null,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (census_run_id, theme_id, article_id)
);

create index if not exists full_corpus_theme_census_items_theme_idx
  on public.full_corpus_theme_census_items(census_run_id, theme_id, relation, batch_index);
create index if not exists full_corpus_theme_census_items_article_idx
  on public.full_corpus_theme_census_items(census_run_id, article_id);

alter table public.full_corpus_theme_census_items enable row level security;
revoke all on public.full_corpus_theme_census_items from public, anon, authenticated;
grant select, insert, update, delete on public.full_corpus_theme_census_items to postgres, service_role;

create or replace function public.normalized_grounding_text_v1(p_text text)
returns text
language sql
immutable
set search_path to 'pg_catalog','public'
as $$
  select lower(regexp_replace(coalesce(p_text,''),'[[:space:]]+',' ','g'))
$$;

create or replace function public.full_corpus_receipt_integrity_v3(p_run_id uuid)
returns boolean
language plpgsql
stable
set search_path to 'pg_catalog','public'
as $function$
declare
  v_run public.full_corpus_scan_runs%rowtype;
  expected_count integer := 0;
  receipt_count integer := 0;
  valid_receipt_count integer := 0;
  batch_count integer := 0;
  valid_batch_count integer := 0;
begin
  select * into v_run from public.full_corpus_scan_runs where id=p_run_id;
  if not found then return false; end if;
  if v_run.status <> 'completed' then return false; end if;
  if coalesce(v_run.analyzed_article_count,0) <= 0 then return false; end if;

  select count(*) into expected_count
  from (
    select unnest(b.article_ids) article_id
    from public.full_corpus_scan_batches b
    where b.run_id=p_run_id and b.status='completed' and b.prompt_version='full_corpus_batch_v3'
  ) x;

  if expected_count <> v_run.analyzed_article_count then return false; end if;

  select count(*) into receipt_count
  from public.full_corpus_article_receipts r
  where r.run_id=p_run_id;
  if receipt_count <> expected_count then return false; end if;

  select count(*) into valid_receipt_count
  from public.full_corpus_article_receipts r
  join public.full_corpus_scan_batches b
    on b.id=r.batch_id and b.run_id=r.run_id and r.article_id=any(b.article_ids)
  join public.articles a on a.id=r.article_id
  where r.run_id=p_run_id
    and b.status='completed'
    and b.prompt_version='full_corpus_batch_v3'
    and r.prompt_version='full_corpus_batch_v3'
    and r.article_analysis_sha256 = coalesce(a.analysis_text_sha256,'')
    and r.article_analysis_sha256 ~ '^[0-9a-f]{64}$'
    and length(btrim(r.grounded_excerpt)) >= 20
    and length(btrim(r.observed_fact)) >= 10
    and position(
      public.normalized_grounding_text_v1(r.grounded_excerpt)
      in public.normalized_grounding_text_v1(a.ocr_text)
    ) > 0;
  if valid_receipt_count <> expected_count then return false; end if;

  select count(*), count(*) filter(where ok)
  into batch_count, valid_batch_count
  from (
    select b.id,
      (
        b.status='completed'
        and b.prompt_version='full_corpus_batch_v3'
        and cardinality(b.article_ids)=b.article_count
        and (
          select count(*) from public.full_corpus_article_receipts r
          where r.run_id=p_run_id and r.batch_id=b.id
        )=b.article_count
        and not exists (
          select 1 from public.full_corpus_article_receipts r
          where r.run_id=p_run_id and r.batch_id=b.id and not (r.article_id=any(b.article_ids))
        )
        and coalesce((
          select count(*)
          from jsonb_array_elements(
            case when jsonb_typeof(b.summary_json->'evidence')='array' then b.summary_json->'evidence' else '[]'::jsonb end
          ) e
          where coalesce(e->>'article_id','') ~* '^[0-9a-f-]{36}$'
        ),0) = cardinality(coalesce(b.evidence_article_ids,'{}'::uuid[]))
        and not exists (
          select 1 from unnest(coalesce(b.evidence_article_ids,'{}'::uuid[])) eid
          where not exists (
            select 1 from jsonb_array_elements(
              case when jsonb_typeof(b.summary_json->'evidence')='array' then b.summary_json->'evidence' else '[]'::jsonb end
            ) e
            where coalesce(e->>'article_id','')=eid::text
          )
        )
      ) ok
    from public.full_corpus_scan_batches b
    where b.run_id=p_run_id
  ) q;

  return batch_count=v_run.total_batches
    and valid_batch_count=batch_count
    and receipt_count=expected_count;
end;
$function$;

create or replace function public.full_corpus_theme_census_integrity_v3(p_census_run_id uuid)
returns boolean
language plpgsql
stable
set search_path to 'pg_catalog','public'
as $function$
declare
  c public.full_corpus_theme_census_runs%rowtype;
  v_theme_count integer := 0;
  v_article_count integer := 0;
  v_expected_items bigint := 0;
  v_actual_items bigint := 0;
  v_valid_items bigint := 0;
begin
  select * into c from public.full_corpus_theme_census_runs where id=p_census_run_id;
  if not found or c.status<>'completed' then return false; end if;
  if not public.full_corpus_receipt_integrity_v3(c.scan_run_id) then return false; end if;
  if jsonb_typeof(c.candidate_themes)<>'array' then return false; end if;

  select count(*) into v_theme_count from jsonb_array_elements(c.candidate_themes);
  select count(*) into v_article_count from public.full_corpus_article_receipts r where r.run_id=c.scan_run_id;
  if v_theme_count < 4 or v_theme_count > 10 then return false; end if;
  if c.candidate_theme_count<>v_theme_count or c.expected_article_count<>v_article_count then return false; end if;

  v_expected_items := v_theme_count::bigint * v_article_count::bigint;
  select count(*) into v_actual_items from public.full_corpus_theme_census_items i where i.census_run_id=p_census_run_id;
  if v_actual_items<>v_expected_items then return false; end if;

  with theme_ids as (
    select t->>'theme_id' theme_id
    from jsonb_array_elements(c.candidate_themes) t
    where coalesce(t->>'theme_id','') ~ '^T[0-9]+$'
  ), checked as (
    select i.*,
      r.batch_id,
      b.batch_index actual_batch_index,
      a.ocr_text,
      (select count(*) from theme_ids t where t.theme_id=i.theme_id)=1 theme_exists
    from public.full_corpus_theme_census_items i
    join public.full_corpus_article_receipts r
      on r.run_id=c.scan_run_id and r.article_id=i.article_id
    join public.full_corpus_scan_batches b on b.id=r.batch_id
    join public.articles a on a.id=i.article_id
    where i.census_run_id=p_census_run_id
  )
  select count(*) filter(where
      theme_exists
      and batch_index=actual_batch_index
      and length(btrim(grounded_excerpt))>=20
      and position(public.normalized_grounding_text_v1(grounded_excerpt) in public.normalized_grounding_text_v1(ocr_text))>0
      and (
        relation='none'
        or length(btrim(rationale))>=8
      )
      and (
        relation not in ('support','counter')
        or evidence_type<>'none'
      )
    )
  into v_valid_items
  from checked;

  return v_valid_items=v_expected_items and c.completed_item_count=v_expected_items;
end;
$function$;

create or replace function public.report_receipt_census_integrity_v3(p_payload jsonb)
returns boolean
language plpgsql
stable
set search_path to 'pg_catalog','public'
as $function$
declare
  generation_path text := coalesce(p_payload->>'generation_path','');
  scan_run_text text := coalesce(p_payload->>'full_corpus_run_id',p_payload#>>'{source_coverage,full_corpus_run_id}','');
  census_run_text text := coalesce(p_payload->>'theme_census_run_id','');
  v_scan_run uuid;
  v_census_run uuid;
  c public.full_corpus_theme_census_runs%rowtype;
  theme_count integer := 0;
  valid_theme_count integer := 0;
  evidence_count integer := 0;
  valid_evidence_count integer := 0;
  counter_count integer := 0;
  valid_counter_count integer := 0;
begin
  if generation_path<>'full_corpus_receipt_census_writer_v3' then return false; end if;
  if scan_run_text !~* '^[0-9a-f-]{36}$' or census_run_text !~* '^[0-9a-f-]{36}$' then return false; end if;
  v_scan_run:=scan_run_text::uuid;
  v_census_run:=census_run_text::uuid;

  select * into c from public.full_corpus_theme_census_runs where id=v_census_run and scan_run_id=v_scan_run;
  if not found then return false; end if;
  if not public.full_corpus_receipt_integrity_v3(v_scan_run) then return false; end if;
  if not public.full_corpus_theme_census_integrity_v3(v_census_run) then return false; end if;

  with themes as (
    select t
    from jsonb_array_elements(case when jsonb_typeof(p_payload->'ranked_themes_raw')='array' then p_payload->'ranked_themes_raw' else '[]'::jsonb end) t
  ), checked as (
    select
      t->>'theme_id' theme_id,
      case when coalesce(t->>'supporting_article_count','')~'^\d+$' then (t->>'supporting_article_count')::integer else -1 end stored_support,
      case when coalesce(t->>'counter_article_count','')~'^\d+$' then (t->>'counter_article_count')::integer else -1 end stored_counter,
      case when coalesce(t->>'supporting_batch_count','')~'^\d+$' then (t->>'supporting_batch_count')::integer else -1 end stored_batches
    from themes
  ), recomputed as (
    select ch.*,
      (select count(*) from public.full_corpus_theme_census_items i where i.census_run_id=v_census_run and i.theme_id=ch.theme_id and i.relation='support') support_count,
      (select count(*) from public.full_corpus_theme_census_items i where i.census_run_id=v_census_run and i.theme_id=ch.theme_id and i.relation='counter') counter_count,
      (select count(distinct batch_index) from public.full_corpus_theme_census_items i where i.census_run_id=v_census_run and i.theme_id=ch.theme_id and i.relation='support') support_batches,
      (select count(*) from public.full_corpus_theme_census_items i where i.census_run_id=v_census_run and i.theme_id=ch.theme_id and i.relation='support' and i.evidence_type in ('consumer_survey','purchase_behavior','usage_behavior','consumer_quote')) direct_support_count
    from checked ch
  )
  select count(*), count(*) filter(where
      theme_id~'^T[0-9]+$'
      and stored_support=support_count
      and stored_counter=counter_count
      and stored_batches=support_batches
      and support_count>=3
      and support_batches>=2
      and direct_support_count>=2
    )
  into theme_count, valid_theme_count
  from recomputed;

  if theme_count<4 or theme_count>6 or valid_theme_count<>theme_count then return false; end if;

  with evidence as (
    select e
    from jsonb_array_elements(case when jsonb_typeof(p_payload->'evidence_matrix')='array' then p_payload->'evidence_matrix' else '[]'::jsonb end) e
  ), checked as (
    select e,
      e->>'theme_id' theme_id,
      case when coalesce(e->>'article_id','')~*'^[0-9a-f-]{36}$' then (e->>'article_id')::uuid else null end article_id
    from evidence
  )
  select count(*), count(*) filter(where exists(
      select 1 from public.full_corpus_theme_census_items i
      where i.census_run_id=v_census_run and i.theme_id=checked.theme_id and i.article_id=checked.article_id and i.relation='support'
    ))
  into evidence_count,valid_evidence_count
  from checked;

  if evidence_count < theme_count*2 or valid_evidence_count<>evidence_count then return false; end if;
  if exists (
    select 1
    from jsonb_array_elements(case when jsonb_typeof(p_payload->'ranked_themes_raw')='array' then p_payload->'ranked_themes_raw' else '[]'::jsonb end) t
    where (
      select count(distinct (e->>'article_id'))
      from jsonb_array_elements(case when jsonb_typeof(p_payload->'evidence_matrix')='array' then p_payload->'evidence_matrix' else '[]'::jsonb end) e
      where e->>'theme_id'=t->>'theme_id'
    ) < 2
  ) then return false; end if;

  with counters as (
    select e
    from jsonb_array_elements(case when jsonb_typeof(p_payload->'counterevidence_matrix')='array' then p_payload->'counterevidence_matrix' else '[]'::jsonb end) e
  ), checked as (
    select e,
      e->>'theme_id' theme_id,
      case when coalesce(e->>'article_id','')~*'^[0-9a-f-]{36}$' then (e->>'article_id')::uuid else null end article_id
    from counters
  )
  select count(*), count(*) filter(where exists(
      select 1 from public.full_corpus_theme_census_items i
      where i.census_run_id=v_census_run and i.theme_id=checked.theme_id and i.article_id=checked.article_id and i.relation='counter'
    ))
  into counter_count,valid_counter_count
  from checked;

  if valid_counter_count<>counter_count then return false; end if;

  return true;
end;
$function$;

revoke all on function public.full_corpus_receipt_integrity_v3(uuid) from public,anon,authenticated;
revoke all on function public.full_corpus_theme_census_integrity_v3(uuid) from public,anon,authenticated;
revoke all on function public.report_receipt_census_integrity_v3(jsonb) from public,anon,authenticated;
grant execute on function public.full_corpus_receipt_integrity_v3(uuid) to postgres,service_role;
grant execute on function public.full_corpus_theme_census_integrity_v3(uuid) to postgres,service_role;
grant execute on function public.report_receipt_census_integrity_v3(jsonb) to postgres,service_role;

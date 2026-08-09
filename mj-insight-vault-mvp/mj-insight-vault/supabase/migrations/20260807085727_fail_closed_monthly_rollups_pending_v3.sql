alter table public.monthly_rollups
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_retry_at timestamptz;

create index if not exists monthly_rollups_worker_idx
  on public.monthly_rollups(status,next_retry_at,lease_expires_at,updated_at);

create or replace function public.formal_month_key_v1(p_article_date text)
returns text
language sql
immutable
set search_path to 'pg_catalog','public'
as $function$
  select case
    when coalesce(p_article_date,'') ~ '^\d{4}-\d{1,2}' then substring(p_article_date from '^(\d{4})')||'-'||lpad(substring(p_article_date from '^\d{4}-(\d{1,2})'),2,'0')
    when coalesce(p_article_date,'') ~ '^\d{4}/\d{1,2}' then substring(p_article_date from '^(\d{4})')||'-'||lpad(substring(p_article_date from '^\d{4}/(\d{1,2})'),2,'0')
    when coalesce(p_article_date,'') ~ '^\d{4}年\s*\d{1,2}月' then substring(p_article_date from '^(\d{4})')||'-'||lpad(substring(p_article_date from '^\d{4}年\s*(\d{1,2})月'),2,'0')
    else 'undated'
  end;
$function$;

create or replace function public.formal_monthly_source_fingerprint_v3(p_month_key text)
returns text
language sql
stable
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
  select encode(extensions.digest(
    coalesce(string_agg(
      f.id::text||':'||coalesce(f.analysis_text_sha256,'')||':'||coalesce(f.source_ocr_sha256,''),
      E'\n' order by f.id::text
    ),'') || E'\nmonth:' || coalesce(p_month_key,'') || E'\nprompt:monthly_rollup_v3_article_reviews',
    'sha256'
  ),'hex')
  from public.formal_corpus_articles_v1 f
  where public.formal_month_key_v1(f.article_date)=p_month_key;
$function$;

create or replace function public.monthly_rollup_v3_payload_integrity_v1(
  p_month_key text,
  p_article_count integer,
  p_article_ids uuid[],
  p_summary_json jsonb
)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with expected as (
  select f.id,f.analysis_text_sha256,regexp_replace(coalesce(f.ocr_text,''),'\s+',' ','g') norm_ocr
  from public.formal_corpus_articles_v1 f
  where public.formal_month_key_v1(f.article_date)=p_month_key
), meta as (
  select count(*) expected_count,
    array_agg(id::text order by id::text) expected_ids
  from expected
), supplied as (
  select coalesce(array_agg(x::text order by x::text),'{}'::text[]) ids
  from unnest(coalesce(p_article_ids,'{}'::uuid[])) x
), json_source as (
  select coalesce(array_agg(v order by v),'{}'::text[]) ids
  from jsonb_array_elements_text(case when jsonb_typeof(p_summary_json->'source_article_ids')='array' then p_summary_json->'source_article_ids' else '[]'::jsonb end) v
), reviews as (
  select item,
    case when coalesce(item->>'article_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (item->>'article_id')::uuid else null end article_id,
    btrim(coalesce(item->>'coverage_anchor_start','')) anchor_start,
    btrim(coalesce(item->>'coverage_anchor_end','')) anchor_end,
    coalesce(item->>'analysis_text_sha256','') analysis_hash
  from jsonb_array_elements(case when jsonb_typeof(p_summary_json->'article_reviews')='array' then p_summary_json->'article_reviews' else '[]'::jsonb end) item
), checked_reviews as (
  select r.*,e.norm_ocr,e.analysis_text_sha256,
    position(lower(regexp_replace(r.anchor_start,'\s+',' ','g')) in lower(e.norm_ocr)) start_pos,
    position(lower(regexp_replace(r.anchor_end,'\s+',' ','g')) in lower(e.norm_ocr)) end_pos
  from reviews r left join expected e on e.id=r.article_id
), evidence as (
  select item,
    case when coalesce(item->>'article_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (item->>'article_id')::uuid else null end article_id,
    btrim(coalesce(item->>'observed_fact',item->>'evidence_excerpt_or_fact','')) fact
  from jsonb_array_elements(case when jsonb_typeof(p_summary_json->'evidence_matrix')='array' then p_summary_json->'evidence_matrix' else '[]'::jsonb end) item
), checked_evidence as (
  select e.*,x.norm_ocr
  from evidence e left join expected x on x.id=e.article_id
), themes as (
  select item,
    coalesce(item->>'theme_id','') theme_id,
    case when jsonb_typeof(item->'support_article_ids')='array' then item->'support_article_ids' else '[]'::jsonb end support_ids,
    case when jsonb_typeof(item->'counter_article_ids')='array' then item->'counter_article_ids' else '[]'::jsonb end counter_ids,
    btrim(coalesce(item->>'what_cannot_be_said','')) cannot_text,
    coalesce(item->>'counterevidence_search_status','') counter_status
  from jsonb_array_elements(case when jsonb_typeof(p_summary_json->'major_themes')='array' then p_summary_json->'major_themes' else '[]'::jsonb end) item
), theme_stats as (
  select t.*,
    (select count(*) from jsonb_array_elements_text(t.support_ids)) support_count,
    (select count(*) from jsonb_array_elements_text(t.support_ids) s(v) where v~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and exists(select 1 from expected e where e.id=v::uuid)) valid_support_count,
    (select count(*) from jsonb_array_elements_text(t.counter_ids)) counter_count,
    (select count(*) from jsonb_array_elements_text(t.counter_ids) c(v) where v~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and exists(select 1 from expected e where e.id=v::uuid)) valid_counter_count
  from themes t
)
select
  coalesce(p_month_key,'')<>'undated'
  and (select expected_count>0 from meta)
  and p_article_count=(select expected_count from meta)
  and cardinality(coalesce(p_article_ids,'{}'::uuid[]))=(select expected_count from meta)
  and (select ids from supplied)=(select expected_ids from meta)
  and (select ids from json_source)=(select expected_ids from meta)
  and coalesce(p_summary_json->>'generation_method','')='monthly_rollup_v3_article_review_hierarchy'
  and coalesce(p_summary_json->>'worker_version','')='monthly_rollup_worker_v3'
  and coalesce(p_summary_json->>'prompt_version','')='monthly_rollup_v3_article_reviews'
  and coalesce(p_summary_json->>'validation_version','')='monthly_rollup_gate_v3'
  and lower(coalesce(p_summary_json->>'rollup_analysis_is_validated','false')) in ('true','1','yes')
  and lower(coalesce(p_summary_json->>'fallback_used','false')) not in ('true','1','yes')
  and coalesce(p_summary_json->>'source_fingerprint','')=public.formal_monthly_source_fingerprint_v3(p_month_key)
  and (select count(*) from reviews)=(select expected_count from meta)
  and (select count(distinct article_id) from reviews)=(select expected_count from meta)
  and not exists(
    select 1 from checked_reviews r
    where r.norm_ocr is null
      or r.analysis_hash<>coalesce(r.analysis_text_sha256,'')
      or length(r.anchor_start)<6 or length(r.anchor_end)<6
      or r.start_pos<=0 or r.end_pos<=0
      or r.start_pos>greatest(1,round(length(r.norm_ocr)*0.65)::integer)
      or r.end_pos<greatest(1,round(length(r.norm_ocr)*0.35)::integer)
  )
  and (select count(*) from evidence)>=least(3,(select expected_count from meta))
  and not exists(
    select 1 from checked_evidence e
    where e.norm_ocr is null or length(e.fact)<6
      or position(lower(regexp_replace(e.fact,'\s+',' ','g')) in lower(e.norm_ocr))<=0
  )
  and (select count(*) from themes) between 1 and 8
  and not exists(
    select 1 from theme_stats t
    where t.theme_id!~'^M[0-9]+$'
      or t.support_count<least(2,(select expected_count from meta))
      or t.valid_support_count<>t.support_count
      or t.valid_counter_count<>t.counter_count
      or t.counter_status<>'completed'
      or length(t.cannot_text)<10
  );
$function$;

create or replace function public.enforce_monthly_rollup_ready_v3_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  if new.status='ready' and not public.monthly_rollup_v3_payload_integrity_v1(new.month_key,new.article_count,new.article_ids,new.summary_json) then
    raise exception using errcode='23514',message='monthly_rollup_v3_integrity_failed',detail='ready requires the formal-corpus V3 article-review, source-hash, full-span anchor, grounded-evidence and theme-support contract';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_enforce_monthly_rollup_ready_v3 on public.monthly_rollups;
create trigger trg_enforce_monthly_rollup_ready_v3
before insert or update of status,article_count,article_ids,summary_json on public.monthly_rollups
for each row execute function public.enforce_monthly_rollup_ready_v3_v1();

update public.monthly_rollups
set status='stale',
    error_message='legacy monthly rollup invalidated: formal-corpus V3 regeneration required',
    updated_at=now(),
    lease_token=null,
    lease_expires_at=null,
    heartbeat_at=null,
    next_retry_at=null
where status='ready';

create or replace function public.enqueue_monthly_rollup(p_month_key text,p_force boolean default false)
returns setof public.monthly_rollups
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  raise exception using errcode='55000',message='monthly_rollup_v3_deployment_required',detail='Legacy monthly worker is disabled because it reads a non-formal corpus and truncates article text. Deploy the V3 worker before enqueueing.';
end;
$function$;

create or replace function public.claim_monthly_rollup(p_month_key text,p_lease_seconds integer default 180)
returns setof public.monthly_rollups
language sql
security definer
set search_path to 'pg_catalog','public'
as $function$
  select * from public.monthly_rollups where false;
$function$;

create or replace function public.claim_next_monthly_rollup(p_lease_seconds integer default 180)
returns setof public.monthly_rollups
language sql
security definer
set search_path to 'pg_catalog','public'
as $function$
  select * from public.monthly_rollups where false;
$function$;

create or replace function public.kick_monthly_rollup_worker()
returns bigint
language sql
security definer
set search_path to 'pg_catalog','public'
as $function$
  select null::bigint;
$function$;

revoke all on function public.enqueue_monthly_rollup(text,boolean) from public,anon,authenticated;
revoke all on function public.claim_monthly_rollup(text,integer) from public,anon,authenticated;
revoke all on function public.claim_next_monthly_rollup(integer) from public,anon,authenticated;
revoke all on function public.kick_monthly_rollup_worker() from public,anon,authenticated;
grant execute on function public.enqueue_monthly_rollup(text,boolean) to postgres,service_role;
grant execute on function public.claim_monthly_rollup(text,integer) to postgres,service_role;
grant execute on function public.claim_next_monthly_rollup(integer) to postgres,service_role;
grant execute on function public.kick_monthly_rollup_worker() to postgres,service_role;

do $block$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname='mj_monthly_rollup_worker' limit 1;
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
end;
$block$;
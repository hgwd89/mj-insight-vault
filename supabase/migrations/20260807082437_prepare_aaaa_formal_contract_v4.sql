create or replace function public.full_corpus_run_integrity_v2(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with target_run as (
  select r.*
  from public.full_corpus_scan_runs r
  where r.id=p_run_id
), batches as (
  select b.*
  from public.full_corpus_scan_batches b
  join target_run r on r.id=b.run_id
), expected_articles as (
  select b.id batch_id,b.batch_index,b.article_count,a.article_id,a.ordinality::integer article_no
  from batches b
  cross join lateral unnest(coalesce(b.article_ids,'{}'::uuid[])) with ordinality a(article_id,ordinality)
), reviews as (
  select b.id batch_id,b.batch_index,
    case when coalesce(j.item->>'article_no','') ~ '^\d+$' then (j.item->>'article_no')::integer else null end article_no,
    case when coalesce(j.item->>'article_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (j.item->>'article_id')::uuid else null end article_id,
    btrim(coalesce(j.item->>'coverage_anchor','')) coverage_anchor,
    lower(coalesce(j.item->>'coverage_anchor_verified','false')) in ('true','1','yes') anchor_flag
  from batches b
  cross join lateral jsonb_array_elements(case when jsonb_typeof(b.summary_json->'article_reviews')='array' then b.summary_json->'article_reviews' else '[]'::jsonb end) j(item)
), review_validation as (
  select e.batch_id,e.batch_index,e.article_id,e.article_no,
    count(r.*) matching_reviews,
    bool_and(
      r.anchor_flag
      and length(r.coverage_anchor)>=6
      and position(
        lower(regexp_replace(r.coverage_anchor,'\s+',' ','g'))
        in lower(regexp_replace(coalesce(a.ocr_text,''),'\s+',' ','g'))
      )>0
    ) grounded
  from expected_articles e
  left join reviews r on r.batch_id=e.batch_id and r.article_no=e.article_no and r.article_id=e.article_id
  left join public.articles a on a.id=e.article_id
  group by e.batch_id,e.batch_index,e.article_id,e.article_no
), evidence_validation as (
  select b.id batch_id,
    count(*) total_evidence,
    count(*) filter(where
      coalesce(j.item->>'article_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and exists(select 1 from expected_articles e where e.batch_id=b.id and e.article_id=(j.item->>'article_id')::uuid)
      and exists(select 1 from public.articles a where a.id=(j.item->>'article_id')::uuid and length(btrim(coalesce(j.item->>'evidence_excerpt_or_fact',j.item->>'source_excerpt','')))>=6 and position(lower(regexp_replace(btrim(coalesce(j.item->>'evidence_excerpt_or_fact',j.item->>'source_excerpt','')),'\s+',' ','g')) in lower(regexp_replace(coalesce(a.ocr_text,''),'\s+',' ','g')))>0)
    ) valid_evidence
  from batches b
  left join lateral jsonb_array_elements(case when jsonb_typeof(b.summary_json->'evidence')='array' then b.summary_json->'evidence' else '[]'::jsonb end) j(item) on true
  group by b.id
), batch_validation as (
  select b.id,
    b.status='completed'
    and b.prompt_version='full_corpus_batch_v3_article_reviews'
    and b.article_count=cardinality(coalesce(b.article_ids,'{}'::uuid[]))
    and coalesce(b.summary_json->>'coverage_contract_version','')='article_review_anchor_v1'
    and lower(coalesce(b.summary_json->>'analysis_is_validated','false')) in ('true','1','yes')
    and lower(coalesce(b.summary_json->>'fallback_used','false')) not in ('true','1','yes')
    and jsonb_array_length(case when jsonb_typeof(b.summary_json->'article_reviews')='array' then b.summary_json->'article_reviews' else '[]'::jsonb end)=b.article_count
    and array(select x::text from unnest(coalesce(b.article_ids,'{}'::uuid[])) x order by x::text)
      = array(select value from jsonb_array_elements_text(case when jsonb_typeof(b.summary_json->'server_supplied_article_ids')='array' then b.summary_json->'server_supplied_article_ids' else '[]'::jsonb end) value order by value)
    and array(select x::text from unnest(coalesce(b.article_ids,'{}'::uuid[])) x order by x::text)
      = array(select value from jsonb_array_elements_text(case when jsonb_typeof(b.summary_json->'model_attested_article_ids')='array' then b.summary_json->'model_attested_article_ids' else '[]'::jsonb end) value order by value)
    and array(select x::text from unnest(coalesce(b.article_ids,'{}'::uuid[])) x order by x::text)
      = array(select value from jsonb_array_elements_text(case when jsonb_typeof(b.summary_json->'read_article_ids')='array' then b.summary_json->'read_article_ids' else '[]'::jsonb end) value order by value)
    as valid
  from batches b
)
select exists(
  select 1
  from target_run r
  where r.status='completed'
    and coalesce(r.coverage_json->>'prompt_version','')='full_corpus_batch_v3_article_reviews'
    and coalesce(r.coverage_json->>'article_review_contract_version','')='article_review_anchor_v1'
    and r.total_batches>0
    and r.completed_batches=r.total_batches
    and r.failed_batches=0
    and coalesce(r.needs_review_batches,0)=0
    and r.active_article_count=r.ocr_ready_article_count
    and r.analyzed_article_count=r.active_article_count
    and (select count(*) from batches)=r.total_batches
    and not exists(select 1 from batch_validation where not valid)
    and (select count(*) from expected_articles)=r.active_article_count
    and (select count(distinct article_id) from expected_articles)=r.active_article_count
    and (select count(*) from review_validation where matching_reviews=1 and grounded)=r.active_article_count
    and not exists(select 1 from review_validation where matching_reviews<>1 or not grounded)
    and not exists(select 1 from expected_articles e left join public.formal_corpus_articles_v1 f on f.id=e.article_id where f.id is null)
    and not exists(select 1 from evidence_validation where total_evidence<>valid_evidence)
);
$function$;

create or replace function public.report_theme_support_integrity_v2(p_payload jsonb,p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with themes as (
  select item,
    item->>'theme_id' theme_id,
    case when jsonb_typeof(item->'supporting_batch_indices')='array' then item->'supporting_batch_indices' else '[]'::jsonb end support_batches
  from jsonb_array_elements(case when jsonb_typeof(p_payload->'major_trends')='array' then p_payload->'major_trends' else '[]'::jsonb end) item
), theme_ids as (
  select theme_id,count(*) n from themes group by theme_id
), evidence as (
  select item,item->>'theme_id' theme_id,item->>'article_id' article_id_text,
    case when coalesce(item->>'article_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (item->>'article_id')::uuid else null end article_id,
    case when coalesce(item->>'batch_index','')~'^\d+$' then (item->>'batch_index')::integer else null end stored_batch_index,
    coalesce(item->>'evidence_type','') evidence_type
  from jsonb_array_elements(case when jsonb_typeof(p_payload->'evidence_matrix')='array' then p_payload->'evidence_matrix' else '[]'::jsonb end) item
), checked_evidence as (
  select e.*,b.batch_index actual_batch_index,a.ocr_text,
    exists(select 1 from themes t where t.theme_id=e.theme_id and exists(select 1 from jsonb_array_elements_text(t.support_batches) s(v) where s.v~'^\d+$' and s.v::integer=b.batch_index)) in_declared_support,
    btrim(coalesce(e.item->>'evidence_excerpt_or_fact','')) fact,
    btrim(coalesce(e.item->>'what_can_be_said','')) can_text,
    btrim(coalesce(e.item->>'what_cannot_be_said',e.item->>'limitation','')) cannot_text
  from evidence e
  left join public.full_corpus_scan_batches b on b.run_id=p_run_id and e.article_id is not null and e.article_id=any(b.article_ids)
  left join public.articles a on a.id=e.article_id
), theme_evidence_stats as (
  select t.theme_id,
    count(e.*) evidence_count,
    count(distinct e.article_id_text) article_count,
    count(distinct e.actual_batch_index) batch_count,
    count(*) filter(where e.evidence_type in ('consumer_survey','direct_consumer','purchase_behavior','usage_behavior','consumer_quote')) direct_count,
    count(*) filter(where e.evidence_type='supply_signal') supply_count,
    count(*) filter(where e.actual_batch_index is not null and e.stored_batch_index=e.actual_batch_index and e.in_declared_support and length(e.fact)>=6 and position(lower(regexp_replace(e.fact,'\s+',' ','g')) in lower(regexp_replace(coalesce(e.ocr_text,''),'\s+',' ','g')))>0 and length(e.can_text)>=10 and length(e.cannot_text)>=10) valid_count
  from themes t left join checked_evidence e on e.theme_id=t.theme_id
  group by t.theme_id
), counter as (
  select item,item->>'theme_id' theme_id,item->>'article_id' article_id_text,
    case when coalesce(item->>'article_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (item->>'article_id')::uuid else null end article_id,
    case when coalesce(item->>'batch_index','')~'^\d+$' then (item->>'batch_index')::integer else null end stored_batch_index,
    btrim(coalesce(item->>'counter_fact','')) counter_fact,
    btrim(coalesce(item->>'effect_on_claim','')) effect_on_claim
  from jsonb_array_elements(case when jsonb_typeof(p_payload->'counterevidence_matrix')='array' then p_payload->'counterevidence_matrix' else '[]'::jsonb end) item
), checked_counter as (
  select c.*,b.batch_index actual_batch_index,a.ocr_text
  from counter c
  left join public.full_corpus_scan_batches b on b.run_id=p_run_id and c.article_id is not null and c.article_id=any(b.article_ids)
  left join public.articles a on a.id=c.article_id
), counter_stats as (
  select t.theme_id,count(c.*) counter_count,count(distinct c.article_id_text) distinct_count,
    count(*) filter(where c.actual_batch_index is not null and c.stored_batch_index=c.actual_batch_index and length(c.counter_fact)>=6 and position(lower(regexp_replace(c.counter_fact,'\s+',' ','g')) in lower(regexp_replace(coalesce(c.ocr_text,''),'\s+',' ','g')))>0 and length(c.effect_on_claim)>=10) valid_count
  from themes t left join checked_counter c on c.theme_id=t.theme_id group by t.theme_id
)
select
  (select count(*) between 1 and 6 from themes)
  and not exists(select 1 from theme_ids where theme_id !~ '^T[0-9]+$' or n<>1)
  and not exists(select 1 from themes where jsonb_array_length(support_batches)<3)
  and not exists(select 1 from themes t cross join lateral jsonb_array_elements_text(t.support_batches) s(v) where s.v!~'^\d+$' or not exists(select 1 from public.full_corpus_scan_batches b where b.run_id=p_run_id and b.status='completed' and b.prompt_version='full_corpus_batch_v3_article_reviews' and b.batch_index=s.v::integer))
  and not exists(select 1 from theme_evidence_stats where evidence_count<3 or article_count<3 or batch_count<3 or direct_count<2 or supply_count>1 or valid_count<>evidence_count)
  and not exists(select 1 from counter_stats where counter_count<1 or distinct_count<1 or valid_count<>counter_count)
  and not exists(select 1 from checked_counter c join checked_evidence e on e.theme_id=c.theme_id and e.article_id_text=c.article_id_text);
$function$;

create or replace function public.report_aaaa_v4_integrity_v1(p_payload jsonb,p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with evidence as (
  select item,item->>'article_id' article_id_text
  from jsonb_array_elements(case when jsonb_typeof(p_payload->'evidence_matrix')='array' then p_payload->'evidence_matrix' else '[]'::jsonb end) item
), counterevidence as (
  select item,item->>'article_id' article_id_text
  from jsonb_array_elements(case when jsonb_typeof(p_payload->'counterevidence_matrix')='array' then p_payload->'counterevidence_matrix' else '[]'::jsonb end) item
), link_ids as (
  select lower((m)[1]) article_id_text
  from regexp_matches(coalesce(p_payload->>'answer_text',''),'/articles/([0-9a-fA-F-]{36})','g') m
)
select
  coalesce(p_payload->>'generation_path','')='full_corpus_hierarchical_theme_evidence_writer_v3'
  and coalesce(p_payload->>'formal_gate_version','')='formal_gate_v4'
  and coalesce(p_payload#>>'{raw_quality_gate,validation_mode}','')='article_coverage_theme_support_v1'
  and coalesce(p_payload#>>'{raw_quality_gate,status}','')='passed'
  and coalesce(p_payload#>>'{article_coverage_contract,version}','')='article_review_anchor_v1'
  and coalesce(p_payload#>>'{article_coverage_contract,status}','')='passed'
  and coalesce(p_payload#>>'{theme_support_gate,status}','')='passed'
  and coalesce(p_payload#>>'{counterevidence_gate,status}','')='passed'
  and coalesce(p_payload#>>'{post_critic_validation,status}','')='passed'
  and coalesce(p_payload#>>'{post_critic_validation,version}','')='post_critic_revalidation_v1'
  and coalesce(p_payload#>>'{semantic_review,status}','')='passed'
  and coalesce(p_payload#>>'{semantic_review,version}','')='adversarial_report_critic_v2'
  and coalesce(p_payload->>'answer_text','') !~* '(https?://|www\.)'
  and public.full_corpus_run_integrity_v2(p_run_id)
  and public.report_theme_support_integrity_v2(p_payload,p_run_id)
  and (select count(*)>=3 from evidence)
  and not exists(select 1 from link_ids l where not exists(select 1 from evidence e where lower(e.article_id_text)=l.article_id_text) and not exists(select 1 from counterevidence c where lower(c.article_id_text)=l.article_id_text));
$function$;

create or replace function public.quarantine_invalid_formal_report_attempt_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  payload jsonb := coalesce(new.answer_json,'{}'::jsonb);
  generation_path text := coalesce(payload->>'generation_path','');
  gate text := coalesce(payload->>'full_corpus_gate',payload#>>'{source_coverage,full_corpus_gate}','failed');
  run_id_text text := coalesce(payload->>'full_corpus_run_id',payload#>>'{source_coverage,full_corpus_run_id}','');
  run_id uuid;
  raw_ok boolean := false;
  analytical_ok boolean := false;
begin
  if generation_path='full_corpus_hierarchical_theme_evidence_writer_v3' then
    return new;
  end if;
  if gate<>'passed' then return new; end if;
  if run_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    run_id:=run_id_text::uuid;
    raw_ok:=public.report_raw_evidence_integrity_v1(payload,run_id);
    analytical_ok:=public.report_evidence_claims_analytical_v1(payload);
  end if;
  if raw_ok and analytical_ok then return new; end if;
  payload:=jsonb_set(payload,'{attempted_full_corpus_gate}','"passed"'::jsonb,true);
  payload:=jsonb_set(payload,'{full_corpus_gate}','"failed"'::jsonb,true);
  payload:=jsonb_set(payload,'{analysis_is_provisional}','true'::jsonb,true);
  payload:=jsonb_set(payload,'{report_kind}','"provisional"'::jsonb,true);
  payload:=jsonb_set(payload,'{analysis_verification_status}','"raw_evidence_unverified"'::jsonb,true);
  payload:=jsonb_set(payload,'{quarantine_reason}',to_jsonb(case when not raw_ok then 'database_raw_evidence_integrity_failed' else 'evidence_claims_not_analytical' end),true);
  payload:=jsonb_set(payload,'{quality_gate,status}','"needs_review"'::jsonb,true);
  payload:=jsonb_set(payload,'{source_coverage,full_corpus_gate}','"failed"'::jsonb,true);
  payload:=jsonb_set(payload,'{source_coverage,attempted_full_corpus_gate}','"passed"'::jsonb,true);
  new.answer_json:=payload;
  return new;
end;
$function$;

create or replace function public.sanitize_full_corpus_scan_evidence_ids()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  allowed_ids text[]; cleaned_ids text[]; cleaned_evidence jsonb; reported_read_ids jsonb; has_evidence boolean; has_signal boolean; content_valid boolean;
begin
  if new.prompt_version='full_corpus_batch_v3_article_reviews' then
    return new;
  end if;
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
    new.summary_json := jsonb_set(new.summary_json, '{validation}', jsonb_build_object('passed', true, 'failures', '[]'::jsonb, 'missing_read_article_ids', '[]'::jsonb, 'server_processed_article_ids', true, 'note', 'Legacy v2 only: model UUID echo mismatch normalized for audit.'), true);
    new.status := 'completed'; new.error_message := null; new.last_error_class := null; new.next_retry_at := null; new.finished_at := coalesce(new.finished_at, now());
  end if;
  return new;
end;
$function$;

create or replace function public.accept_validated_no_signal_scan_batch()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  v_validated boolean; v_has_evidence boolean; v_has_signal boolean; v_failures jsonb;
  v_expected_failure constant text := 'consumer_narratives / behavior_signals / weak_signals are all empty';
  v_allowed_ids jsonb; v_reported_read_ids jsonb;
begin
  if new.prompt_version='full_corpus_batch_v3_article_reviews' then return new; end if;
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
  new.summary_json := jsonb_set(new.summary_json, '{validation}', jsonb_build_object('passed', true, 'failures', '[]'::jsonb, 'missing_read_article_ids', '[]'::jsonb, 'accepted_as_no_signal_batch', true, 'server_processed_article_ids', true, 'note', 'Legacy v2 no-signal normalization only.'), true);
  new.status := 'completed'; new.finished_at := coalesce(new.finished_at, now()); new.updated_at := now(); new.next_retry_at := null; new.last_error_class := null; new.error_message := null; return new;
end;
$function$;

create or replace function public.sync_chat_report_metadata()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  payload jsonb := coalesce(new.answer_json,'{}'::jsonb);
  gate text := coalesce(payload->>'full_corpus_gate',payload#>>'{source_coverage,full_corpus_gate}','failed');
  run_id_text text := coalesce(payload->>'full_corpus_run_id',payload#>>'{source_coverage,full_corpus_run_id}','');
  run_id uuid;
  generation_path text := coalesce(payload->>'generation_path','');
  v4_candidate boolean := generation_path='full_corpus_hierarchical_theme_evidence_writer_v3' and gate='passed';
  v4_ok boolean := false;
  legacy_candidate boolean := gate='passed' and not v4_candidate;
  generation_status_value text := coalesce(nullif(payload->>'generation_status',''),'completed');
  report_kind_value text := coalesce(payload->>'report_kind','');
  report_chat boolean := lower(coalesce(payload->>'report_chat','false')) in ('true','1','yes');
  provisional boolean := lower(coalesce(payload->>'analysis_is_provisional',payload#>>'{source_coverage,analysis_is_provisional}','false')) in ('true','1','yes');
begin
  if run_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then run_id:=run_id_text::uuid; end if;
  if v4_candidate and run_id is not null then v4_ok:=public.report_aaaa_v4_integrity_v1(payload,run_id); end if;

  if tg_op='INSERT' and v4_candidate and not v4_ok then
    raise exception using errcode='23514',message='formal_report_aaaa_v4_integrity_failed',detail='AAAA v4 reports require article-level source anchors, exact theme support membership, actual counterevidence and post-critic revalidation.';
  end if;
  if tg_op='INSERT' and v4_candidate and new.source_job_id is null then
    raise exception using errcode='23514',message='formal_report_source_job_missing',detail='AAAA formal reports must be linked to a durable report job.';
  end if;

  new.full_corpus_gate:=gate;
  new.is_formal_report:=v4_candidate and v4_ok and new.source_job_id is not null and not provisional and not report_chat and generation_status_value='completed';
  new.generation_status:=generation_status_value;
  new.report_kind:=case when report_kind_value='diagnostic' or generation_status_value='blocked' then 'diagnostic' when report_chat then 'followup' when new.is_formal_report then 'formal' else 'provisional' end;
  new.analysis_verification_status:=case
    when new.is_formal_report then 'full_corpus_verified_v4'
    when new.report_kind='followup' then 'derived_followup'
    when new.report_kind='diagnostic' then 'blocked_diagnostic'
    when legacy_candidate then 'aaaa_contract_pending'
    when v4_candidate and not v4_ok then 'aaaa_v4_integrity_failed'
    when provisional then 'provisional_unverified'
    else 'quality_unverified' end;
  return new;
end;
$function$;
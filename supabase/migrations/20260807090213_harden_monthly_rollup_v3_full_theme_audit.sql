create or replace function public.monthly_rollup_v3_payload_integrity_v2(
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
  select count(*) expected_count,array_agg(id::text order by id::text) expected_ids from expected
), supplied as (
  select coalesce(array_agg(x::text order by x::text),'{}'::text[]) ids from unnest(coalesce(p_article_ids,'{}'::uuid[])) x
), json_source as (
  select coalesce(array_agg(v order by v),'{}'::text[]) ids from jsonb_array_elements_text(case when jsonb_typeof(p_summary_json->'source_article_ids')='array' then p_summary_json->'source_article_ids' else '[]'::jsonb end) v
), reviews as (
  select item,
    case when coalesce(item->>'article_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (item->>'article_id')::uuid else null end article_id,
    btrim(coalesce(item->>'coverage_anchor_start','')) anchor_start,
    btrim(coalesce(item->>'coverage_anchor_end','')) anchor_end,
    btrim(coalesce(item->>'evidence_excerpt','')) evidence_excerpt,
    coalesce(item->>'analysis_text_sha256','') analysis_hash,
    case when coalesce(item->>'review_chunk_index','')~'^\d+$' then (item->>'review_chunk_index')::integer else null end review_chunk_index
  from jsonb_array_elements(case when jsonb_typeof(p_summary_json->'article_reviews')='array' then p_summary_json->'article_reviews' else '[]'::jsonb end) item
), checked_reviews as (
  select r.*,e.norm_ocr,e.analysis_text_sha256,
    position(lower(regexp_replace(r.anchor_start,'\s+',' ','g')) in lower(e.norm_ocr)) start_pos,
    position(lower(regexp_replace(r.anchor_end,'\s+',' ','g')) in lower(e.norm_ocr)) end_pos,
    case when r.evidence_excerpt='' then 1 else position(lower(regexp_replace(r.evidence_excerpt,'\s+',' ','g')) in lower(e.norm_ocr)) end evidence_pos
  from reviews r left join expected e on e.id=r.article_id
), evidence as (
  select item,
    case when coalesce(item->>'article_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (item->>'article_id')::uuid else null end article_id,
    btrim(coalesce(item->>'observed_fact',item->>'evidence_excerpt_or_fact','')) fact
  from jsonb_array_elements(case when jsonb_typeof(p_summary_json->'evidence_matrix')='array' then p_summary_json->'evidence_matrix' else '[]'::jsonb end) item
), checked_evidence as (
  select e.*,x.norm_ocr from evidence e left join expected x on x.id=e.article_id
), themes as (
  select item,coalesce(item->>'theme_id','') theme_id,
    case when jsonb_typeof(item->'support_article_ids')='array' then item->'support_article_ids' else '[]'::jsonb end support_ids,
    case when jsonb_typeof(item->'counter_article_ids')='array' then item->'counter_article_ids' else '[]'::jsonb end counter_ids,
    btrim(coalesce(item->>'what_cannot_be_said','')) cannot_text,
    coalesce(item->>'counterevidence_search_status','') counter_status
  from jsonb_array_elements(case when jsonb_typeof(p_summary_json->'major_themes')='array' then p_summary_json->'major_themes' else '[]'::jsonb end) item
), audits as (
  select item,coalesce(item->>'theme_id','') theme_id,
    case when jsonb_typeof(item->'support_article_ids')='array' then item->'support_article_ids' else '[]'::jsonb end support_ids,
    case when jsonb_typeof(item->'counter_article_ids')='array' then item->'counter_article_ids' else '[]'::jsonb end counter_ids,
    case when jsonb_typeof(item->'neutral_article_ids')='array' then item->'neutral_article_ids' else '[]'::jsonb end neutral_ids
  from jsonb_array_elements(case when jsonb_typeof(p_summary_json->'theme_audit')='array' then p_summary_json->'theme_audit' else '[]'::jsonb end) item
), audit_stats as (
  select a.*,
    (select count(*) from jsonb_array_elements_text(a.support_ids)) support_count,
    (select count(*) from jsonb_array_elements_text(a.counter_ids)) counter_count,
    (select count(*) from jsonb_array_elements_text(a.neutral_ids)) neutral_count,
    (select count(distinct v) from (
      select value v from jsonb_array_elements_text(a.support_ids)
      union all select value from jsonb_array_elements_text(a.counter_ids)
      union all select value from jsonb_array_elements_text(a.neutral_ids)
    ) u) union_distinct_count,
    (select count(*) from (
      select value v from jsonb_array_elements_text(a.support_ids)
      union all select value from jsonb_array_elements_text(a.counter_ids)
      union all select value from jsonb_array_elements_text(a.neutral_ids)
    ) u where v!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not exists(select 1 from expected e where e.id=v::uuid)) invalid_id_count,
    (select count(distinct r.review_chunk_index) from reviews r where r.article_id::text in (select value from jsonb_array_elements_text(a.support_ids))) support_chunk_count
  from audits a
), theme_pairs as (
  select t.theme_id,
    array(select value from jsonb_array_elements_text(t.support_ids) order by value) theme_support,
    array(select value from jsonb_array_elements_text(t.counter_ids) order by value) theme_counter,
    array(select value from jsonb_array_elements_text(a.support_ids) order by value) audit_support,
    array(select value from jsonb_array_elements_text(a.counter_ids) order by value) audit_counter,
    t.cannot_text,t.counter_status,
    a.theme_id audit_theme_id
  from themes t left join audits a on a.theme_id=t.theme_id
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
  and coalesce(p_summary_json#>>'{semantic_review,status}','')='passed'
  and coalesce(p_summary_json#>>'{semantic_review,version}','')='monthly_rollup_adversarial_critic_v1'
  and coalesce(p_summary_json#>>'{post_critic_validation,status}','')='passed'
  and coalesce(p_summary_json#>>'{post_critic_validation,version}','')='monthly_rollup_post_critic_v1'
  and coalesce(p_summary_json->>'summary_text','') !~* '(https?://|www\.)'
  and (select count(*) from reviews)=(select expected_count from meta)
  and (select count(distinct article_id) from reviews)=(select expected_count from meta)
  and not exists(select 1 from checked_reviews r where r.norm_ocr is null or r.analysis_hash<>coalesce(r.analysis_text_sha256,'') or r.review_chunk_index is null or length(r.anchor_start)<6 or length(r.anchor_end)<6 or r.start_pos<=0 or r.end_pos<=0 or r.start_pos>greatest(1,round(length(r.norm_ocr)*0.65)::integer) or r.end_pos<greatest(1,round(length(r.norm_ocr)*0.35)::integer) or r.evidence_pos<=0)
  and (select count(*) from evidence)>=least(3,(select expected_count from meta))
  and not exists(select 1 from checked_evidence e where e.norm_ocr is null or length(e.fact)<6 or position(lower(regexp_replace(e.fact,'\s+',' ','g')) in lower(e.norm_ocr))<=0)
  and (select count(*) from themes) between 1 and 6
  and (select count(distinct theme_id) from themes)=(select count(*) from themes)
  and not exists(select 1 from themes where theme_id!~'^M[0-9]+$' or counter_status<>'completed' or length(cannot_text)<10)
  and (select count(*) from audits)=(select count(*) from themes)
  and (select count(distinct theme_id) from audits)=(select count(*) from audits)
  and not exists(select 1 from audit_stats a where a.invalid_id_count<>0 or a.support_count+a.counter_count+a.neutral_count<>(select expected_count from meta) or a.union_distinct_count<>(select expected_count from meta) or a.support_count<case when (select expected_count from meta)=1 then 1 when (select expected_count from meta)<=10 then 2 else least(12,greatest(3,ceil((select expected_count from meta)*0.01)::integer)) end or ((select expected_count from meta)>20 and a.support_chunk_count<2))
  and not exists(select 1 from theme_pairs p where p.audit_theme_id is null or p.theme_support<>p.audit_support or p.theme_counter<>p.audit_counter)
  and not exists(select 1 from evidence e where not exists(select 1 from audits a where e.article_id::text in (select value from jsonb_array_elements_text(a.support_ids))));
$function$;

create or replace function public.enforce_monthly_rollup_ready_v3_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  if new.status='ready' and not public.monthly_rollup_v3_payload_integrity_v2(new.month_key,new.article_count,new.article_ids,new.summary_json) then
    raise exception using errcode='23514',message='monthly_rollup_v3_integrity_failed',detail='ready requires exact formal-corpus source hashes, full-span article reviews, all-article theme audit, grounded evidence, adversarial critic and post-critic validation';
  end if;
  return new;
end;
$function$;

create or replace view public.monthly_rollup_gate_v3
with (security_invoker=true)
as
select r.id,r.month_key,r.status,r.article_count,
  coalesce(c.article_count,0) expected_article_count,
  public.formal_monthly_source_fingerprint_v3(r.month_key) expected_source_fingerprint,
  public.monthly_rollup_v3_payload_integrity_v2(r.month_key,r.article_count,r.article_ids,r.summary_json) integrity_ok,
  coalesce(r.summary_json->>'generation_method','') generation_method,
  coalesce(r.summary_json->>'worker_version','') worker_version,
  coalesce(r.summary_json->>'prompt_version','') prompt_version,
  coalesce(r.summary_json->>'validation_version','') validation_version,
  r.generated_at,r.error_message,r.updated_at
from public.monthly_rollups r
left join public.formal_month_article_counts_v1 c on c.month_key=r.month_key;
create or replace function public.report_evidence_claims_analytical_v1(p_payload jsonb)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with items as (
 select item
 from jsonb_array_elements(case when jsonb_typeof(p_payload->'evidence_matrix')='array' then p_payload->'evidence_matrix' else '[]'::jsonb end) item
), checked as (
 select i.item,a.headline,
   lower(regexp_replace(btrim(coalesce(i.item->>'claim','')),'\s+',' ','g')) claim_norm,
   lower(regexp_replace(btrim(coalesce(a.headline,'')),'\s+',' ','g')) headline_norm
 from items i
 left join public.articles a on coalesce(i.item->>'article_id',i.item->>'id','') ~* '^[0-9a-f-]{36}$'
   and a.id=coalesce(i.item->>'article_id',i.item->>'id')::uuid
)
select count(*) between 5 and 12
  and count(*) filter(where a.headline is not null)=count(*)
  and count(*) filter(where length(claim_norm)>=15 and claim_norm<>headline_norm and claim_norm not like '根拠候補%')=count(*)
from checked a;
$function$;

create or replace function public.quarantine_invalid_formal_report_attempt_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  payload jsonb := coalesce(new.answer_json,'{}'::jsonb);
  gate text := coalesce(payload->>'full_corpus_gate',payload#>>'{source_coverage,full_corpus_gate}','failed');
  run_id_text text := coalesce(payload->>'full_corpus_run_id',payload#>>'{source_coverage,full_corpus_run_id}','');
  run_id uuid;
  raw_ok boolean := false;
  analytical_ok boolean := false;
begin
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
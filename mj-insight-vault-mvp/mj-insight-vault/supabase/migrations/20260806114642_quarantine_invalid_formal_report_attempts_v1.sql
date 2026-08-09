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
begin
  if gate <> 'passed' then return new; end if;
  if run_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    run_id := run_id_text::uuid;
    raw_ok := public.report_raw_evidence_integrity_v1(payload,run_id);
  end if;
  if raw_ok then return new; end if;

  payload := jsonb_set(payload,'{attempted_full_corpus_gate}','"passed"'::jsonb,true);
  payload := jsonb_set(payload,'{full_corpus_gate}','"failed"'::jsonb,true);
  payload := jsonb_set(payload,'{analysis_is_provisional}','true'::jsonb,true);
  payload := jsonb_set(payload,'{report_kind}','"provisional"'::jsonb,true);
  payload := jsonb_set(payload,'{analysis_verification_status}','"raw_evidence_unverified"'::jsonb,true);
  payload := jsonb_set(payload,'{quarantine_reason}','"database_raw_evidence_integrity_failed"'::jsonb,true);
  payload := jsonb_set(payload,'{quality_gate,status}','"needs_review"'::jsonb,true);
  payload := jsonb_set(payload,'{source_coverage,full_corpus_gate}','"failed"'::jsonb,true);
  payload := jsonb_set(payload,'{source_coverage,attempted_full_corpus_gate}','"passed"'::jsonb,true);
  new.answer_json := payload;
  return new;
end;
$function$;

drop trigger if exists trg_000_quarantine_invalid_formal_attempt_v1 on public.chat_reports;
create trigger trg_000_quarantine_invalid_formal_attempt_v1
before insert or update of answer_json on public.chat_reports
for each row execute function public.quarantine_invalid_formal_report_attempt_v1();
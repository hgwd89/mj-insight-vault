create or replace function public.report_aaaa_contract_v1(p_payload jsonb)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
  select
    coalesce(p_payload->>'generation_path','') = 'full_corpus_hierarchical_theme_evidence_writer_v3'
    and coalesce(p_payload->>'formal_gate_version','') = 'formal_gate_v4'
    and coalesce(p_payload#>>'{raw_quality_gate,validation_mode}','') = 'article_coverage_theme_support_v1'
    and coalesce(
      p_payload->>'full_corpus_prompt_version',
      p_payload#>>'{source_coverage,full_corpus_prompt_version}',
      ''
    ) = 'full_corpus_batch_v3_article_reviews'
    and coalesce(p_payload#>>'{article_coverage_contract,version}','') = 'article_review_anchor_v1'
    and coalesce(p_payload#>>'{article_coverage_contract,status}','') = 'passed'
    and coalesce(p_payload#>>'{theme_support_gate,status}','') = 'passed'
    and coalesce(p_payload#>>'{counterevidence_gate,status}','') = 'passed'
    and coalesce(p_payload#>>'{post_critic_validation,status}','') = 'passed';
$function$;

create or replace function public.enforce_aaaa_formal_contract_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  payload jsonb := coalesce(new.answer_json,'{}'::jsonb);
  candidate boolean :=
    coalesce(payload->>'full_corpus_gate',payload#>>'{source_coverage,full_corpus_gate}','failed')='passed'
    or coalesce(payload->>'report_kind','')='formal'
    or lower(coalesce(payload->>'is_formal_report','false')) in ('true','1','yes')
    or coalesce(new.report_kind,'')='formal'
    or coalesce(new.is_formal_report,false)=true;
begin
  if not candidate then
    return new;
  end if;

  if public.report_aaaa_contract_v1(payload) then
    return new;
  end if;

  payload := jsonb_set(payload,'{aaaa_formal_gate}',jsonb_build_object(
    'status','blocked',
    'version','aaaa_contract_v1',
    'reason','formal_gate_v4_and_article_review_v3_required',
    'legacy_generation_path',coalesce(payload->>'generation_path',''),
    'revalidated_at',now()
  ),true);
  payload := jsonb_set(payload,'{is_formal_report}','false'::jsonb,true);
  payload := jsonb_set(payload,'{report_kind}','"provisional"'::jsonb,true);
  payload := jsonb_set(payload,'{analysis_verification_status}','"aaaa_contract_pending"'::jsonb,true);

  new.answer_json := payload;
  new.is_formal_report := false;
  new.report_kind := case when coalesce(new.report_kind,'')='diagnostic' then 'diagnostic' else 'provisional' end;
  new.analysis_verification_status := 'aaaa_contract_pending';
  return new;
end;
$function$;

drop trigger if exists trg_zzzz_enforce_aaaa_formal_contract_v1 on public.chat_reports;
create trigger trg_zzzz_enforce_aaaa_formal_contract_v1
before insert or update of answer_json on public.chat_reports
for each row execute function public.enforce_aaaa_formal_contract_v1();

update public.chat_reports
set answer_json = jsonb_set(
  coalesce(answer_json,'{}'::jsonb),
  '{aaaa_revalidation_requested_at}',
  to_jsonb(now()::text),
  true
)
where is_formal_report=true or report_kind='formal';
create or replace function public.sync_chat_report_metadata()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  payload jsonb := coalesce(new.answer_json,'{}'::jsonb);
  gate text := coalesce(payload->>'full_corpus_gate',payload#>>'{source_coverage,full_corpus_gate}','failed');
  integrity_gate text := coalesce(payload->>'full_corpus_integrity_gate',payload#>>'{source_coverage,full_corpus_integrity_gate}','failed');
  prompt_version text := coalesce(payload->>'full_corpus_prompt_version',payload#>>'{source_coverage,full_corpus_prompt_version}','');
  all_batches_represented boolean := lower(coalesce(payload->>'final_context_all_batches_represented',payload#>>'{source_coverage,final_context_all_batches_represented}','false')) in ('true','1','yes');
  omitted_text text := coalesce(payload->>'final_context_omitted_batches',payload#>>'{source_coverage,final_context_omitted_batches}','0');
  represented_batches_text text := coalesce(payload->>'final_context_represented_batches',payload#>>'{source_coverage,final_context_represented_batches}','0');
  represented_articles_text text := coalesce(payload->>'final_context_represented_article_count',payload#>>'{source_coverage,final_context_represented_article_count}','0');
  omitted_batches integer := 0;
  represented_batches integer := 0;
  represented_articles integer := 0;
  quality_status text := coalesce(payload#>>'{quality_gate,status}','');
  gate_version text := coalesce(payload->>'formal_gate_version',payload#>>'{raw_quality_gate,version}','');
  validation_mode text := coalesce(payload#>>'{raw_quality_gate,validation_mode}','');
  generation_status_value text := coalesce(nullif(payload->>'generation_status',''),'completed');
  report_kind_value text := coalesce(payload->>'report_kind','');
  generation_warning text := lower(coalesce(payload->>'generation_warning',''));
  report_chat boolean := lower(coalesce(payload->>'report_chat','false')) in ('true','1','yes');
  provisional boolean := lower(coalesce(payload->>'analysis_is_provisional',payload#>>'{source_coverage,analysis_is_provisional}',payload#>>'{coverage_diagnosis,analysis_is_provisional}','false')) in ('true','1','yes');
  blocked boolean := generation_status_value='blocked' or report_kind_value='diagnostic' or report_chat;
  fallback_used boolean := generation_warning like '%emergency_fallback%' or generation_warning like '%extractive_fallback%' or generation_warning like '%openai_api_key missing%' or lower(coalesce(payload->>'fallback_used','false')) in ('true','1','yes');
  full_corpus_candidate boolean := gate='passed' and not blocked;
  run_id_text text := coalesce(payload->>'full_corpus_run_id',payload#>>'{source_coverage,full_corpus_run_id}','');
  run_id uuid;
  metadata_integrity boolean;
  database_run_integrity boolean := false;
  database_raw_integrity boolean := false;
  database_analytical_integrity boolean := false;
  valid_validation_pair boolean;
  formal boolean;
begin
  if omitted_text ~ '^\d+$' then omitted_batches:=omitted_text::integer; end if;
  if represented_batches_text ~ '^\d+$' then represented_batches:=represented_batches_text::integer; end if;
  if represented_articles_text ~ '^\d+$' then represented_articles:=represented_articles_text::integer; end if;
  if run_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then run_id:=run_id_text::uuid; end if;

  metadata_integrity := integrity_gate='passed' and prompt_version='full_corpus_batch_v2' and all_batches_represented and omitted_batches=0 and represented_batches>0 and represented_articles>0;
  if run_id is not null then
    database_run_integrity:=public.full_corpus_run_integrity_v1(run_id);
    database_raw_integrity:=public.report_raw_evidence_integrity_v1(payload,run_id);
    database_analytical_integrity:=public.report_evidence_claims_analytical_v1(payload);
  end if;

  valid_validation_pair :=
    (gate_version='formal_gate_v2' and validation_mode='raw_before_enrichment')
    or (gate_version='formal_gate_v3' and validation_mode='writer_critic_grounded_v1');

  formal := full_corpus_candidate and metadata_integrity and database_run_integrity and database_raw_integrity and database_analytical_integrity and new.source_job_id is not null and valid_validation_pair and quality_status='passed' and not provisional and not fallback_used;

  if tg_op='INSERT' and full_corpus_candidate and not valid_validation_pair then
    raise exception using errcode='23514',message='formal_report_validation_pair_invalid',detail='Formal reports require formal_gate_v2/raw_before_enrichment or formal_gate_v3/writer_critic_grounded_v1.';
  end if;
  if tg_op='INSERT' and full_corpus_candidate and not metadata_integrity then
    raise exception using errcode='23514',message='formal_report_integrity_gate_missing',detail='A formal report requires full_corpus_batch_v2 and an all-batch final context with zero omissions.';
  end if;
  if tg_op='INSERT' and full_corpus_candidate and not database_run_integrity then
    raise exception using errcode='23514',message='formal_report_run_integrity_failed',detail='The referenced scan run does not pass database-recomputed v2 batch integrity.';
  end if;
  if tg_op='INSERT' and full_corpus_candidate and not database_raw_integrity then
    raise exception using errcode='23514',message='formal_report_raw_evidence_integrity_failed',detail='The report evidence does not pass database-recomputed evidence integrity and article grounding.';
  end if;
  if tg_op='INSERT' and full_corpus_candidate and not database_analytical_integrity then
    raise exception using errcode='23514',message='formal_report_analytical_claim_integrity_failed',detail='Evidence claims must be analytical and must not copy article headlines.';
  end if;
  if tg_op='INSERT' and full_corpus_candidate and new.source_job_id is null then
    raise exception using errcode='23514',message='formal_report_source_job_missing',detail='Formal reports must be linked to a durable report job.';
  end if;

  new.full_corpus_gate:=gate;
  new.is_formal_report:=formal;
  new.generation_status:=generation_status_value;
  new.report_kind:=case when report_kind_value='diagnostic' or new.generation_status='blocked' then 'diagnostic' when report_chat then 'followup' when formal then 'formal' else 'provisional' end;
  new.analysis_verification_status:=case
    when formal then 'full_corpus_verified'
    when new.report_kind='followup' then 'derived_followup'
    when new.report_kind='diagnostic' then 'blocked_diagnostic'
    when not metadata_integrity and full_corpus_candidate then 'integrity_unverified'
    when not database_run_integrity and full_corpus_candidate then 'run_integrity_unverified'
    when not database_raw_integrity and full_corpus_candidate then 'raw_evidence_unverified'
    when not database_analytical_integrity and full_corpus_candidate then 'analytical_claims_unverified'
    when new.source_job_id is null and full_corpus_candidate then 'source_job_unverified'
    when provisional then 'provisional_unverified'
    when fallback_used then 'fallback_unverified'
    when not valid_validation_pair then 'validation_mode_unverified'
    else 'quality_unverified' end;
  return new;
end;
$function$;
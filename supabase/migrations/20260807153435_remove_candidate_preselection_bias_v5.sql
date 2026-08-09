create or replace function public.validate_theme_candidate_v4_row()
returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_locked timestamptz;begin
  select candidate_set_locked_at into v_locked from public.theme_analysis_runs_v4 where id=coalesce(new.analysis_run_id,old.analysis_run_id);
  if v_locked is not null then raise exception using errcode='23514',message='candidate_set_is_locked'; end if;
  if tg_op<>'DELETE' then
    if char_length(btrim(new.title))<2 or char_length(btrim(new.definition))<20 or char_length(btrim(new.scope_boundary))<12 then raise exception using errcode='23514',message='candidate_definition_too_short'; end if;
    if new.subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear') then raise exception using errcode='23514',message='candidate_subject_invalid'; end if;
    if new.measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other') then raise exception using errcode='23514',message='candidate_measurement_invalid'; end if;
    if cardinality(coalesce(new.evidence_article_ids,'{}'::uuid[]))<>0 then raise exception using errcode='23514',message='candidate_pre_census_evidence_ids_forbidden'; end if;
    if cardinality(coalesce(new.supporting_batch_indices,'{}'::integer[]))<>0 then raise exception using errcode='23514',message='candidate_pre_census_support_batches_forbidden'; end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
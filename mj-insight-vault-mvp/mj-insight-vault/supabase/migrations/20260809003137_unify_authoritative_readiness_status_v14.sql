begin;

do $$
declare
  v_def text;
  v_target constant text := '''readiness_status'',r.readiness_status,';
  v_replacement constant text := '''readiness_status'',v_status,';
begin
  select pg_get_functiondef(p.oid)
    into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'pipeline_readiness_json_v10'
    and pg_get_function_identity_arguments(p.oid) = ''
  limit 1;

  if coalesce(v_def,'') = '' then
    raise exception 'pipeline_readiness_json_v10_missing';
  end if;
  if position(v_target in v_def) = 0 then
    raise exception 'pipeline_readiness_json_v10_expected_legacy_status_assignment_missing';
  end if;

  v_def := replace(v_def, v_target, v_replacement);
  execute v_def;
end
$$;

do $$
declare
  j jsonb;
begin
  j := public.pipeline_readiness_json_v10();
  if coalesce(j->>'readiness_status','') = '' then
    raise exception 'pipeline_readiness_json_v10_readiness_status_missing';
  end if;
  if (j->>'readiness_status') is distinct from (j->>'readiness_status_v8') then
    raise exception 'pipeline_readiness_json_v10_status_alias_mismatch_after_fix: readiness_status=%, readiness_status_v8=%', j->>'readiness_status', j->>'readiness_status_v8';
  end if;
end
$$;

commit;
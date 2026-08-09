begin;

do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='pipeline_readiness_json_v10' and pg_get_function_identity_arguments(p.oid)=''
  limit 1;
  if coalesce(v_def,'')='' then raise exception 'pipeline_readiness_json_v10_missing'; end if;
  if position('r public.aaaa_pipeline_readiness_v7%rowtype;' in v_def)=0
     or position('select * into r from public.aaaa_pipeline_readiness_v7;' in v_def)=0 then
    raise exception 'pipeline_readiness_v10_expected_legacy_dependency_missing';
  end if;
  v_def:=replace(v_def,'r public.aaaa_pipeline_readiness_v7%rowtype;','r public.aaaa_pipeline_readiness_v6%rowtype;');
  v_def:=replace(v_def,'select * into r from public.aaaa_pipeline_readiness_v7;','select * into r from public.aaaa_pipeline_readiness_v6;');
  execute v_def;
end
$$;

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='pipeline_readiness_json_v10' and pg_get_function_identity_arguments(p.oid)=''
  limit 1;
  if position('aaaa_pipeline_readiness_v7' in coalesce(v_def,''))<>0 then raise exception 'pipeline_readiness_v10_legacy_v7_dependency_still_present'; end if;
  if position('select * into r from public.aaaa_pipeline_readiness_v6;' in coalesce(v_def,''))=0 then raise exception 'pipeline_readiness_v10_v6_base_not_installed'; end if;
end
$$;

commit;
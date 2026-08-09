begin;
create or replace function public.record_verified_theme_census_receipt_v8()
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare g record;a public.verified_theme_analysis_runs_v7%rowtype;r public.verified_article_review_corpus_receipts_v7%rowtype;v_rel integer;v_fp text;v_id uuid;
begin
  select * into g from public.verified_theme_census_gate_v7;
  if g.census_gate<>'passed' then raise exception 'verified_census_receipt_v10_gate_required'; end if;
  select * into a from public.verified_theme_analysis_runs_v7 where id=g.analysis_run_id;
  select * into r from public.current_verified_article_review_corpus_receipt_v7 where id=a.review_receipt_id;
  if r.id is null then raise exception 'verified_census_receipt_v10_review_receipt_stale'; end if;
  select count(*)::integer into v_rel from public.verified_theme_census_relations_v7 where analysis_run_id=a.id;
  select encode(extensions.digest(convert_to(
    coalesce((select string_agg(o.article_id::text||':'||array_to_string(o.matched_candidate_ids,','),'|' order by o.article_id::text) from public.verified_theme_census_article_outcomes_v7 o where o.analysis_run_id=a.id),'')
    ||'###'||coalesce((select string_agg(x.article_id::text||':'||x.candidate_id::text||':'||x.relation||':'||x.mapping_confidence::text||':'||x.mapper_source_anchor||':'||x.critic_source_anchor,'|' order by x.article_id::text,x.candidate_id::text) from public.verified_theme_census_relations_v7 x where x.analysis_run_id=a.id),'')
  ,'UTF8'),'sha256'),'hex') into v_fp;
  insert into public.verified_theme_census_receipts_v8(analysis_run_id,review_receipt_id,candidate_set_fingerprint,article_count,candidate_count,relation_count,census_fingerprint)
  values(a.id,r.id,a.candidate_set_fingerprint,r.article_count,g.candidate_count,v_rel,v_fp)
  on conflict(analysis_run_id) do update set review_receipt_id=excluded.review_receipt_id,candidate_set_fingerprint=excluded.candidate_set_fingerprint,article_count=excluded.article_count,candidate_count=excluded.candidate_count,relation_count=excluded.relation_count,census_fingerprint=excluded.census_fingerprint,created_at=now()
  returning id into v_id;
  return v_id;
end
$function$;
commit;
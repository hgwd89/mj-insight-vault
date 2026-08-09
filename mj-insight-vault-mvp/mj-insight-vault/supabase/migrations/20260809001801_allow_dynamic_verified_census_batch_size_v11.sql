create or replace function public.enqueue_verified_theme_census_v7(p_article_batch_size integer default 10)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  a public.verified_theme_analysis_runs_v7%rowtype;
  r public.verified_article_review_corpus_receipts_v7%rowtype;
  v_size integer:=greatest(1,least(12,coalesce(p_article_batch_size,10)));
  v_candidates integer;
  v_count integer;
begin
  if (select candidate_gate from public.verified_theme_candidate_gate_v7)<>'passed' then raise exception 'verified_census_v7_candidate_gate_required'; end if;
  select ar.* into a from public.verified_theme_analysis_runs_v7 ar join public.verified_theme_candidate_gate_v7 g on g.analysis_run_id=ar.id and g.candidate_gate='passed';
  if a.id is null then raise exception 'verified_census_v7_analysis_missing'; end if;
  select * into r from public.current_verified_article_review_corpus_receipt_v7 where id=a.review_receipt_id;
  if r.id is null then raise exception 'verified_census_v7_review_receipt_stale'; end if;
  select count(*)::integer into v_candidates from public.verified_theme_candidates_v7 where analysis_run_id=a.id;
  if not exists(select 1 from public.verified_theme_census_batches_v7 where analysis_run_id=a.id) then
    with src as (
      select v.article_id,v.analysis_text_sha256,row_number() over(order by v.article_id) rn
      from public.formal_verified_article_text_v5 v
      join public.verified_article_reviews_v6 ar on ar.article_id=v.article_id and ar.classification_receipt_id=r.classification_receipt_id
    ),grp as (
      select ((rn-1)/v_size+1)::integer batch_index,array_agg(article_id order by article_id) article_ids,count(*)::integer article_count,
             encode(extensions.digest(convert_to(string_agg(article_id::text||':'||analysis_text_sha256,'|' order by article_id)||'|'||a.candidate_set_fingerprint,'UTF8'),'sha256'),'hex') fp
      from src group by ((rn-1)/v_size+1)::integer
    )
    insert into public.verified_theme_census_batches_v7(analysis_run_id,batch_index,article_ids,article_count,candidate_set_fingerprint,article_batch_fingerprint,status,finished_at)
    select a.id,batch_index,article_ids,article_count,a.candidate_set_fingerprint,fp,case when v_candidates=0 then 'completed' else 'queued' end,case when v_candidates=0 then now() else null end from grp order by batch_index;
  end if;
  if v_candidates=0 then
    insert into public.verified_theme_census_article_outcomes_v7(analysis_run_id,batch_id,article_id,candidate_set_fingerprint,matched_candidate_ids,updated_at)
    select a.id,b.id,u.article_id,a.candidate_set_fingerprint,'{}'::uuid[],now() from public.verified_theme_census_batches_v7 b cross join lateral unnest(b.article_ids) u(article_id) where b.analysis_run_id=a.id
    on conflict(analysis_run_id,article_id) do update set batch_id=excluded.batch_id,candidate_set_fingerprint=excluded.candidate_set_fingerprint,matched_candidate_ids='{}'::uuid[],updated_at=now();
  end if;
  update public.verified_theme_analysis_runs_v7 set status='census',updated_at=now() where id=a.id and status='candidates_ready';
  select count(*)::integer into v_count from public.verified_theme_census_batches_v7 where analysis_run_id=a.id;
  return v_count;
end
$function$;

revoke all on function public.enqueue_verified_theme_census_v7(integer) from public, anon, authenticated;
grant execute on function public.enqueue_verified_theme_census_v7(integer) to service_role;
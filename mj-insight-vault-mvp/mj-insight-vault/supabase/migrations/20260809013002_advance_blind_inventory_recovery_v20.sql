begin;

create or replace function public.advance_blind_inventory_recovery_v20()
returns jsonb
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare v_job uuid;v_result jsonb;v_remaining integer;
begin
  select j.id into v_job
  from public.source_page_article_inventory_jobs_v1 j
  where exists(
    select 1 from public.source_page_article_inventory_consensus_groups_v2 cg
    left join public.source_page_article_inventory_mappings_v2 m on m.job_id=cg.job_id and m.group_fingerprint=cg.group_fingerprint
    where cg.job_id=j.id and cg.group_kind='article' and m.group_fingerprint is null
  )
  order by j.created_at,j.id
  for update skip locked
  limit 1;
  if v_job is not null then
    v_result:=public.recover_blind_inventory_articles_v18(v_job);
    select count(*)::integer into v_remaining
    from public.source_page_article_inventory_consensus_groups_v2 cg
    join public.source_page_article_inventory_jobs_v1 j on j.id=cg.job_id
    left join public.source_page_article_inventory_mappings_v2 m on m.job_id=cg.job_id and m.group_fingerprint=cg.group_fingerprint
    where cg.group_kind='article' and m.group_fingerprint is null;
    return jsonb_build_object('status','recovery_progress','job_id',v_job,'result',v_result,'remaining_jobs_or_groups',v_remaining,'external_calls',0);
  end if;
  v_result:=public.refreeze_recovered_inventory_corpus_v19();
  return jsonb_build_object('status','refreeze', 'result',v_result,'external_calls',0);
end
$function$;

revoke all on function public.advance_blind_inventory_recovery_v20() from public,anon,authenticated;
grant execute on function public.advance_blind_inventory_recovery_v20() to service_role;

commit;
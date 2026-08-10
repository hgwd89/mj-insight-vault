begin;

create or replace function public.requeue_source_page_article_inventory_job_v3(
  p_job_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
begin
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then
    raise exception 'inventory_v3_freeze_stale';
  end if;

  select * into j
    from public.source_page_article_inventory_jobs_v1
   where id=p_job_id
   for update;
  if not found then
    raise exception 'inventory_v3_requeue_job_not_found';
  end if;
  if j.status not in ('failed','needs_review','discovery_required') then
    raise exception 'inventory_v3_requeue_not_allowed_from_%',j.status;
  end if;

  delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=p_job_id;
  delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=p_job_id;
  delete from public.source_page_article_inventory_mappings_v2 where job_id=p_job_id;
  delete from public.source_page_article_inventory_groups_v1 where job_id=p_job_id;
  delete from public.source_page_article_inventory_pass_runs_v1 where job_id=p_job_id;

  update public.source_page_article_inventory_jobs_v1
     set status='queued',
         requires_third_pass=false,
         lease_token=null,
         lease_expires_at=null,
         error_message=null,
         finished_at=null,
         attempt_count=0,
         updated_at=now()
   where id=p_job_id;

  return jsonb_build_object(
    'status','queued',
    'proofs_reset',true,
    'requires_third_pass',false,
    'prior_status',j.status
  );
end
$function$;

revoke all on function public.requeue_source_page_article_inventory_job_v3(uuid) from public,anon,authenticated;
grant execute on function public.requeue_source_page_article_inventory_job_v3(uuid) to service_role;

commit;

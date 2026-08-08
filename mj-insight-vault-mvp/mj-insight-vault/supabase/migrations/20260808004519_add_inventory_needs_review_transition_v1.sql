create or replace function public.review_source_page_article_inventory_job_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare j public.source_page_article_inventory_jobs_v1%rowtype;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then
    raise exception 'inventory_v1_review_lease_invalid';
  end if;
  update public.source_page_article_inventory_jobs_v1
     set status='needs_review', lease_token=null, lease_expires_at=null,
         error_message=left(coalesce(p_reason,'manual review required'),4000),
         updated_at=now()
   where id=p_job_id;
  return jsonb_build_object('status','needs_review','reason',left(coalesce(p_reason,'manual review required'),4000));
end
$function$;
revoke all on function public.review_source_page_article_inventory_job_v1(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.review_source_page_article_inventory_job_v1(uuid,uuid,text) to service_role;
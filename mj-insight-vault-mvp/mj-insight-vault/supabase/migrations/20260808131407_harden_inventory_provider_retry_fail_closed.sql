create or replace function public.fail_source_page_article_inventory_job_v2(
  p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_message text:=coalesce(p_error_message,'inventory worker failed');
  v_structural boolean;
  v_permanent_provider boolean;
  v_failures integer;
  v_next text;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'inventory_v2_fail_lease_invalid'; end if;
  v_structural := v_message ~* '(groups array is missing|group is not an object|invalid group_kind|empty block_indices|unknown block index|assigned more than once|headline_anchor|non_article_role|block partition incomplete|mappings array missing|mapping row count mismatch|mapping row is not an object|invalid or duplicate group mapping|invalid or duplicate article mapping|mapping is not bijective|exhausted repair attempt|source_region_materialization_v6)';
  v_permanent_provider := v_message ~* 'OpenAI Responses API failed: 4[0-9][0-9]'
    and not (v_message ~* 'OpenAI Responses API failed: (408|409|429)');
  v_failures:=j.attempt_count+1;
  v_next:=case
    when v_structural then 'needs_review'
    when v_permanent_provider then 'failed'
    when coalesce(p_retryable,true) and v_failures<4 then 'queued'
    else 'failed'
  end;
  update public.source_page_article_inventory_jobs_v1
     set status=v_next,attempt_count=v_failures,lease_token=null,lease_expires_at=null,
         error_message=left(v_message,4000),updated_at=now(),finished_at=case when v_next='failed' then now() else null end
   where id=p_job_id;
  return jsonb_build_object('status',v_next,'attempt_count',v_failures,'retry_scheduled',(v_next='queued'),'structural_failure',v_structural,'permanent_provider_failure',v_permanent_provider);
end
$function$;
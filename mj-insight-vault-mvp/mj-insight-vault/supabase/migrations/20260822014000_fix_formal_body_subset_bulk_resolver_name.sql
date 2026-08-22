drop function if exists public.bulk_resolve_inventory_review_by_formal_body_subset_exclusion_v(integer);

create or replace function public.bulk_resolve_inventory_formal_body_subset_exclusion_v1(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
set statement_timeout to '240s'
as $function$
declare
  v_job record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_resolved integer := 0;
  v_failed integer := 0;
begin
  for v_job in
    select j.id
    from public.source_page_article_inventory_jobs_v1 j
    join public.formal_corpus_freeze_gate_v2 fg
      on fg.freeze_receipt_id = j.freeze_receipt_id
     and fg.freeze_gate_v2 = 'passed'
    where j.inventory_version = 'page_article_inventory_v4_recovered_ocr'
      and j.status = 'needs_review'
      and j.requires_third_pass
      and j.existing_article_count >= 2
      and not exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 r where r.job_id = j.id)
      and not exists(select 1 from public.source_page_article_inventory_mappings_v2 m where m.job_id = j.id)
      and not exists(select 1 from public.source_region_materialization_receipts_v6 r where r.inventory_job_id = j.id)
    order by j.updated_at, j.id
    limit v_limit
  loop
    begin
      v_result := public.resolve_inventory_review_by_formal_body_subset_exclusion_v1(v_job.id);
      v_resolved := v_resolved + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object('job_id', v_job.id, 'ok', true, 'result', v_result));
    exception when others then
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object('job_id', v_job.id, 'ok', false, 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'attempted', v_resolved + v_failed,
    'resolved', v_resolved,
    'failed', v_failed,
    'results', v_results
  );
end
$function$;

revoke all on function public.bulk_resolve_inventory_formal_body_subset_exclusion_v1(integer) from public, anon, authenticated;
grant execute on function public.bulk_resolve_inventory_formal_body_subset_exclusion_v1(integer) to service_role;

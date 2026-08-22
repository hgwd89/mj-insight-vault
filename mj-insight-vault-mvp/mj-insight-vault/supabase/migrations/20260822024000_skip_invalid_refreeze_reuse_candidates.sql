create or replace function public.mark_next_refreeze_inventory_reuse_candidate_review_v1(
  p_source_freeze uuid,
  p_error_message text
)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_current_freeze uuid;
  v_target_job_id uuid;
  v_source_job_id uuid;
begin
  select freeze_receipt_id
    into v_current_freeze
  from public.formal_corpus_freeze_gate_v2
  where freeze_gate_v2 = 'passed';

  if v_current_freeze is null or p_source_freeze is null or p_source_freeze = v_current_freeze then
    raise exception 'mark_refreeze_reuse_candidate_freeze_mismatch';
  end if;

  select n.id, s.id
    into v_target_job_id, v_source_job_id
  from public.source_page_article_inventory_jobs_v1 n
  join public.source_page_article_inventory_jobs_v1 s
    on s.id <> n.id
   and s.freeze_receipt_id = p_source_freeze
   and s.status = 'completed'
   and s.inventory_version = n.inventory_version
   and s.page_identity_source_image_id = n.page_identity_source_image_id
   and s.inventory_source_image_id is not distinct from n.inventory_source_image_id
   and s.source_ocr_json_sha256 is not distinct from n.source_ocr_json_sha256
   and s.block_count is not distinct from n.block_count
   and s.existing_article_count is not distinct from n.existing_article_count
   and s.page_article_set_fingerprint is not distinct from n.page_article_set_fingerprint
  join public.source_page_inventory_visual_consensus_receipts_v4 vr
    on vr.job_id = s.id
   and vr.article_count = s.existing_article_count
  where n.freeze_receipt_id = v_current_freeze
    and n.status = 'queued'
    and n.inventory_version = 'page_article_inventory_v4_recovered_ocr'
    and not exists(select 1 from public.source_page_article_inventory_pass_runs_v1 p where p.job_id = n.id)
    and not exists(select 1 from public.source_page_article_inventory_groups_v1 g where g.job_id = n.id)
    and not exists(select 1 from public.source_page_inventory_visual_region_evidence_v6 e where e.job_id = n.id)
    and not exists(select 1 from public.source_page_inventory_visual_consensus_receipts_v4 v where v.job_id = n.id)
    and not exists(select 1 from public.source_page_article_inventory_mappings_v2 m where m.job_id = n.id)
    and public.inventory_consensus_source_v3(s.id) is not null
    and (select count(*) from public.source_page_article_inventory_consensus_groups_v3 cg where cg.job_id = s.id) = s.existing_article_count
    and (select count(*) from public.source_page_article_inventory_mappings_v2 m where m.job_id = s.id) = s.existing_article_count
    and (select count(distinct article_id) from public.source_page_article_inventory_mappings_v2 m where m.job_id = s.id) = s.existing_article_count
    and (select count(*) from public.source_page_article_inventory_pass_runs_v1 p where p.job_id = s.id and p.pass_kind in ('mapper', 'critic', 'adjudicator')) = 3
    and (select count(distinct model) from public.source_page_article_inventory_pass_runs_v1 p where p.job_id = s.id and p.pass_kind in ('mapper', 'critic', 'adjudicator')) = 3
    and not exists (
      select 1
      from public.source_page_article_inventory_mappings_v2 m
      where m.job_id = s.id
        and m.mapping_method = 'semantic_review'
        and not (
          exists (
            select 1
            from public.source_page_inventory_semantic_mapping_receipts_v1 rr
            where rr.job_id = s.id
              and rr.group_fingerprint = m.group_fingerprint
              and rr.article_id = m.article_id
          )
          or exists (
            select 1
            from public.inventory_body_grounded_mapping_receipts_v2 br
            where br.job_id = s.id
              and br.group_fingerprint = m.group_fingerprint
              and br.article_id = m.article_id
          )
        )
    )
    and not exists (
      (select m.article_id
       from public.source_page_article_inventory_mappings_v2 m
       where m.job_id = s.id
       except
       select a.id
       from public.formal_corpus_articles_v1 a
       join public.source_page_capture_map_v1 cm
         on cm.source_image_id = a.source_image_id
       where cm.page_identity_source_image_id = n.page_identity_source_image_id)
      union all
      (select a.id
       from public.formal_corpus_articles_v1 a
       join public.source_page_capture_map_v1 cm
         on cm.source_image_id = a.source_image_id
       where cm.page_identity_source_image_id = n.page_identity_source_image_id
       except
       select m.article_id
       from public.source_page_article_inventory_mappings_v2 m
       where m.job_id = s.id)
    )
  order by n.id
  limit 1;

  if v_target_job_id is null then
    return 0;
  end if;

  update public.source_page_article_inventory_jobs_v1
     set status = 'needs_review',
         lease_token = null,
         lease_expires_at = null,
         error_message = left(
           'refreeze_reuse_post_validation_failed; source_job_id=' || v_source_job_id::text || '; error=' || coalesce(p_error_message, ''),
           2000
         ),
         finished_at = now(),
         updated_at = now()
   where id = v_target_job_id
     and status = 'queued';

  return 1;
end
$function$;

create or replace function public.run_refreeze_inventory_reuse_once_v1(
  p_source_freeze uuid,
  p_limit integer default 5,
  p_cron_job_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions', 'cron'
set statement_timeout to '300s'
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5), 10));
  v_lock_key bigint := hashtextextended('run_refreeze_inventory_reuse_once_v1:' || coalesce(p_source_freeze::text, ''), 0);
  v_result jsonb;
  v_one jsonb;
  v_reused integer := 0;
  v_skipped integer := 0;
  v_marked integer := 0;
  v_error text;
  i integer;
begin
  if not pg_try_advisory_lock(v_lock_key) then
    return jsonb_build_object('status', 'skipped', 'reason', 'refreeze_reuse_already_running', 'api_calls', 0);
  end if;

  begin
    begin
      select public.bulk_reuse_refreeze_completed_inventory_fast_v1(p_source_freeze, v_limit)
        into v_result;
      v_reused := coalesce((v_result->>'reused')::integer, 0);
    exception when others then
      v_error := sqlerrm;
      if v_error not like 'fast_refreeze_reuse_post_validation_failed:%' then
        raise;
      end if;

      for i in 1..v_limit loop
        begin
          select public.bulk_reuse_refreeze_completed_inventory_fast_v1(p_source_freeze, 1)
            into v_one;
          if coalesce((v_one->>'reused')::integer, 0) = 0 then
            exit;
          end if;
          v_reused := v_reused + coalesce((v_one->>'reused')::integer, 0);
        exception when others then
          v_error := sqlerrm;
          if v_error not like 'fast_refreeze_reuse_post_validation_failed:%' then
            raise;
          end if;
          select public.mark_next_refreeze_inventory_reuse_candidate_review_v1(p_source_freeze, v_error)
            into v_marked;
          if coalesce(v_marked, 0) = 0 then
            raise;
          end if;
          v_skipped := v_skipped + v_marked;
        end;
      end loop;

      v_result := jsonb_build_object('reused', v_reused, 'skipped_needs_review', v_skipped, 'api_calls', 0);
    end;

    if coalesce((v_result->>'reused')::integer, 0) = 0
       and coalesce((v_result->>'skipped_needs_review')::integer, 0) = 0
       and coalesce(p_cron_job_name, '') <> '' then
      perform cron.unschedule(p_cron_job_name);
      v_result := v_result || jsonb_build_object('unscheduled', true, 'cron_job_name', p_cron_job_name);
    end if;

    perform pg_advisory_unlock(v_lock_key);
    return v_result;
  exception when others then
    perform pg_advisory_unlock(v_lock_key);
    raise;
  end;
end
$function$;

revoke all on function public.mark_next_refreeze_inventory_reuse_candidate_review_v1(uuid, text) from public, anon, authenticated;
revoke all on function public.run_refreeze_inventory_reuse_once_v1(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.mark_next_refreeze_inventory_reuse_candidate_review_v1(uuid, text) to service_role;
grant execute on function public.run_refreeze_inventory_reuse_once_v1(uuid, integer, text) to service_role;

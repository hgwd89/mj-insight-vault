create or replace function public.enforce_inventory_state_contract_v3()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_enabled boolean;
  v_set record;
  v_reopen_ok boolean:=false;
  v_recovery_override boolean:=false;
  v_strict_reuse_override boolean:=false;
  v_exact_consensus_override boolean:=false;
  v_refreeze_reuse_override boolean:=false;
begin
  if tg_op='UPDATE' then
    if old.state_contract_version>=2 and new.state_contract_version<old.state_contract_version then
      raise exception 'inventory_state_contract_version_cannot_downgrade';
    end if;
    if old.state_contract_version>=2 and new.baseline_requires_third_pass is distinct from old.baseline_requires_third_pass then
      raise exception 'inventory_baseline_requires_third_pass_is_immutable';
    end if;
    if old.inventory_version='page_article_inventory_v4_recovered_ocr' and old.status='completed' then
      if new.status='completed' then raise exception 'completed_inventory_job_row_is_immutable'; end if;
      if new.status='discovery_required' then
        select exists(select 1 from public.source_page_inventory_v4_attempt_archive_v6 a where a.job_id=old.id and a.archived_at>=old.updated_at and (a.job_snapshot-'raw_region_evidence')=to_jsonb(old) and a.archive_reason is not distinct from new.error_message and a.archive_writer='postgres') into v_reopen_ok;
      elsif new.status='queued' and new.requires_third_pass then
        select exists(select 1 from public.inventory_structural_completed_reopen_archives_v1 a where a.job_id=old.id and a.archived_at>=old.updated_at and a.job_snapshot=to_jsonb(old) and a.archive_writer='postgres') into v_reopen_ok;
      end if;
      if not v_reopen_ok then raise exception 'completed_inventory_reopen_requires_fresh_exact_archive'; end if;
    end if;
  end if;

  if new.state_contract_version>=2 and new.baseline_requires_third_pass and not new.requires_third_pass then
    raise exception 'inventory_state_contract_v2_baseline_third_must_remain_required';
  end if;

  if new.state_contract_version>=2 and new.inventory_version='page_article_inventory_v4_recovered_ocr' and new.status='completed' then
    if tg_op='INSERT' then raise exception 'inventory_completed_insert_not_allowed'; end if;
    if old.status is distinct from 'completed' then
      select enabled into v_enabled from public.inventory_v3_execution_control_v1 where singleton=true;

      if not coalesce(v_enabled,false) and old.status='discovery_required' then
        select exists(select 1 from public.inventory_recovered_articles_v18 r where r.inventory_job_id=new.id and coalesce(r.recovered_text_sha256,'') ~ '^[0-9a-f]{64}$')
          and not exists(select cg.group_fingerprint from public.source_page_article_inventory_consensus_groups_v3 cg where cg.job_id=new.id except select m.group_fingerprint from public.source_page_article_inventory_mappings_v2 m where m.job_id=new.id)
          and not exists(select m.group_fingerprint from public.source_page_article_inventory_mappings_v2 m where m.job_id=new.id except select cg.group_fingerprint from public.source_page_article_inventory_consensus_groups_v3 cg where cg.job_id=new.id)
          and not exists(select fa.id from public.formal_corpus_articles_v1 fa join public.source_page_capture_map_v1 cm on cm.source_image_id=fa.source_image_id where cm.page_identity_source_image_id=new.page_identity_source_image_id except select m.article_id from public.source_page_article_inventory_mappings_v2 m where m.job_id=new.id)
          and not exists(select m.article_id from public.source_page_article_inventory_mappings_v2 m where m.job_id=new.id except select fa.id from public.formal_corpus_articles_v1 fa join public.source_page_capture_map_v1 cm on cm.source_image_id=fa.source_image_id where cm.page_identity_source_image_id=new.page_identity_source_image_id)
        into v_recovery_override;
      end if;

      if not coalesce(v_enabled,false) then
        select exists(
          select 1 from public.inventory_strict_disabled_completed_reuse_receipts_v1 r
          where r.target_job_id=new.id
            and r.target_freeze_receipt_id=new.freeze_receipt_id
            and r.mapped_article_count=new.existing_article_count
            and coalesce(r.proof_fingerprint,'') ~ '^[0-9a-f]{64}$'
        ) into v_strict_reuse_override;
      end if;

      if not coalesce(v_enabled,false) then
        select exists(
          select 1 from public.inventory_strict_disabled_exact_consensus_completion_receipts_v1 r
          where r.target_job_id=new.id
            and r.target_freeze_receipt_id=new.freeze_receipt_id
            and r.mapped_article_count=new.existing_article_count
            and coalesce(r.consensus_fingerprint,'') ~ '^[0-9a-f]{64}$'
            and coalesce(r.proof_fingerprint,'') ~ '^[0-9a-f]{64}$'
        ) into v_exact_consensus_override;
      end if;

      if not coalesce(v_enabled,false) then
        select exists(
          select 1 from public.inventory_post_discovery_refreeze_reuse_receipts_v1 r
          where r.target_job_id=new.id
            and r.target_freeze_receipt_id=new.freeze_receipt_id
            and r.source_freeze_receipt_id is distinct from new.freeze_receipt_id
            and r.mapped_article_count=new.existing_article_count
            and coalesce(r.source_visual_consensus_fingerprint,'') ~ '^[0-9a-f]{64}$'
            and coalesce(r.proof_fingerprint,'') ~ '^[0-9a-f]{64}$'
        ) into v_refreeze_reuse_override;
      end if;

      if not coalesce(v_enabled,false)
         and not v_recovery_override
         and not v_strict_reuse_override
         and not v_exact_consensus_override
         and not v_refreeze_reuse_override then
        raise exception 'inventory_completion_blocked_execution_control_disabled';
      end if;

      select * into v_set from public.inventory_page_article_set_proof_v1(new.page_identity_source_image_id);
      if v_set.article_count is distinct from new.existing_article_count or v_set.article_set_fingerprint is distinct from new.page_article_set_fingerprint then
        raise exception 'inventory_completion_page_article_set_not_current';
      end if;
      perform public.ensure_inventory_completion_consensus_receipt_v2(new.id,new.existing_article_count,new.block_count,new.requires_third_pass);
    end if;
  end if;
  return new;
end
$function$;

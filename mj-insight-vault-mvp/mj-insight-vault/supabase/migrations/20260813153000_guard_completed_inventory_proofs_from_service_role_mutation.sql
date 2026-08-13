create or replace function public.guard_completed_inventory_proof_mutation_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  v_row jsonb;
  v_job_id uuid;
begin
  if current_user='postgres' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  v_row:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_job_id:=nullif(v_row->>tg_argv[0],'')::uuid;
  if v_job_id is not null and exists(
    select 1 from public.source_page_article_inventory_jobs_v1 j
    where j.id=v_job_id and j.inventory_version='page_article_inventory_v4_recovered_ocr' and j.status='completed'
  ) then
    raise exception 'completed_inventory_proof_is_immutable:%:%',tg_table_name,v_job_id;
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

create or replace function public.guard_completed_inventory_region_mutation_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
declare
  v_row jsonb;
  v_partition uuid;
begin
  if current_user='postgres' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  v_row:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_partition:=nullif(v_row->>'partition_job_id','')::uuid;
  if v_partition is not null and exists(
    select 1
    from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.status='completed'
      and (
        exists(select 1 from public.source_region_materialization_receipts_v6 mr where mr.inventory_job_id=j.id and mr.partition_job_id=v_partition)
        or exists(
          select 1 from public.source_page_partition_jobs_v3 p
          where p.id=v_partition
            and p.page_identity_source_image_id=j.page_identity_source_image_id
            and p.evidence_source_image_id=j.inventory_source_image_id
            and p.freeze_receipt_id=j.freeze_receipt_id
            and p.source_ocr_json_sha256=j.source_ocr_json_sha256
            and p.page_article_set_fingerprint=j.page_article_set_fingerprint
        )
      )
  ) then
    raise exception 'completed_inventory_region_is_immutable:%',v_partition;
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

do $block$
declare r record;
begin
  for r in select * from (values
    ('source_page_inventory_visual_region_evidence_v6','job_id'),
    ('source_page_inventory_visual_group_evidence_v4','job_id'),
    ('source_page_inventory_visual_consensus_receipts_v4','job_id'),
    ('source_page_inventory_two_pass_normalization_receipts_v1','job_id'),
    ('source_page_inventory_semantic_group_consolidation_receipts_v1','job_id'),
    ('source_page_inventory_semantic_mapping_receipts_v1','job_id'),
    ('source_page_inventory_semantic_overrides_v1','job_id'),
    ('source_page_inventory_recovered_headline_overrides_v1','job_id'),
    ('source_page_inventory_visual_exclusions_v1','job_id'),
    ('inventory_body_grounded_mapping_receipts_v1','job_id'),
    ('inventory_body_grounded_mapping_receipts_v2','job_id'),
    ('source_inventory_block_assignments_v7','inventory_job_id')
  ) v(table_name,job_column)
  loop
    execute format('drop trigger if exists trg_guard_completed_inventory_proof_mutation_v1 on public.%I',r.table_name);
    execute format('create trigger trg_guard_completed_inventory_proof_mutation_v1 before insert or update or delete on public.%I for each row execute function public.guard_completed_inventory_proof_mutation_v1(%L)',r.table_name,r.job_column);
  end loop;
end
$block$;

drop trigger if exists trg_guard_completed_inventory_region_mutation_v1 on public.article_source_regions;
create trigger trg_guard_completed_inventory_region_mutation_v1
before insert or update or delete on public.article_source_regions
for each row execute function public.guard_completed_inventory_region_mutation_v1();

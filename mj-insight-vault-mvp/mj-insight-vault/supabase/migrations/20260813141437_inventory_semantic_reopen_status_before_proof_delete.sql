create or replace function public.reopen_completed_inventory_for_semantic_correction_v1(p_job_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_archive_id uuid;
begin
  if char_length(btrim(coalesce(p_reason,''))) < 20 then raise exception 'inventory_semantic_reopen_reason_too_short'; end if;
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status <> 'completed' then raise exception 'inventory_semantic_reopen_requires_completed'; end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'inventory_semantic_reopen_freeze_stale'; end if;

  insert into public.source_page_inventory_v4_attempt_archive_v6(
    job_id,archive_reason,job_snapshot,pass_runs,groups_snapshot,mapping_pass_runs,mappings_snapshot,
    visual_consensus_receipt,visual_group_evidence,materialization_receipts,assignments_snapshot
  ) values(
    j.id,p_reason,
    to_jsonb(j) || jsonb_build_object('raw_region_evidence',coalesce((select jsonb_agg(to_jsonb(r) order by r.recorded_at,r.pass_kind,r.article_seq) from public.source_page_inventory_visual_region_evidence_v6 r where r.job_id=j.id),'[]'::jsonb)),
    coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.pass_kind) from public.source_page_article_inventory_pass_runs_v1 p where p.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(g) order by g.pass_kind,g.group_kind,g.group_fingerprint) from public.source_page_article_inventory_groups_v1 g where g.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(mp) order by mp.created_at,mp.pass_kind) from public.source_page_article_inventory_mapping_pass_runs_v2 mp where mp.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(m) order by m.group_fingerprint) from public.source_page_article_inventory_mappings_v2 m where m.job_id=j.id),'[]'::jsonb),
    (select to_jsonb(v) from public.source_page_inventory_visual_consensus_receipts_v4 v where v.job_id=j.id),
    coalesce((select jsonb_agg(to_jsonb(e) order by e.recorded_at,e.pass_kind,e.original_group_fingerprint) from public.source_page_inventory_visual_group_evidence_v4 e where e.job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(r)) from public.source_region_materialization_receipts_v6 r where r.inventory_job_id=j.id),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(a) order by a.block_index) from public.source_inventory_block_assignments_v7 a where a.inventory_job_id=j.id),'[]'::jsonb)
  ) returning archive_id into v_archive_id;

  update public.source_page_article_inventory_jobs_v1
  set status='discovery_required',error_message=p_reason,finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()
  where id=j.id;

  delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id;
  delete from public.source_page_article_inventory_mappings_v2 where job_id=j.id;

  return jsonb_build_object('status','discovery_required','job_id',j.id,'archive_id',v_archive_id,'reason',p_reason);
end
$function$;

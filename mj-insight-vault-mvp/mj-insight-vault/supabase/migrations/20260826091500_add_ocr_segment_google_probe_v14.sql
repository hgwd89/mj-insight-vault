begin;

create table if not exists public.ocr_segment_google_probes_v14 (
  job_id uuid not null references public.ocr_consensus_jobs_v11(id) on delete cascade,
  article_id uuid not null,
  segmentation_version text not null,
  segmentation_spec_sha256 text not null,
  segment_count integer not null check (segment_count > 0),
  source_image_sha256 text not null,
  crop_image_sha256 text not null,
  google_segment_text text not null,
  google_segment_text_sha256 text not null,
  google_response_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (job_id, article_id)
);

alter table public.ocr_segment_google_probes_v14 enable row level security;
revoke all on table public.ocr_segment_google_probes_v14 from public, anon, authenticated;
grant select, insert, update on table public.ocr_segment_google_probes_v14 to postgres, service_role;

create or replace function public.get_ocr_segment_google_canary_input_v14(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  src public.ocr_verification_page_jobs_v2%rowtype;
  v_inventory_job uuid;
  v_recovery_job uuid;
  v_articles jsonb;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id=p_job_id;
  if not found then raise exception 'ocr_segment_google_v14_job_missing'; end if;
  if j.is_canary is distinct from true then raise exception 'ocr_segment_google_v14_canary_only'; end if;
  if j.status not in ('needs_review','queued','completed') then raise exception 'ocr_segment_google_v14_job_state_not_probeable'; end if;

  select * into src from public.ocr_verification_page_jobs_v2 where id=j.source_job_id;
  if not found then raise exception 'ocr_segment_google_v14_source_job_missing'; end if;
  if not exists(
    select 1 from public.formal_corpus_freeze_gate_v2 fg
    where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=src.freeze_receipt_id
  ) then raise exception 'ocr_segment_google_v14_freeze_stale'; end if;

  select rec.inventory_job_id into v_inventory_job
  from public.source_region_materialization_receipts_v6 rec
  where rec.partition_job_id=src.partition_job_id;
  if v_inventory_job is null then raise exception 'ocr_segment_google_v14_materialization_missing'; end if;

  select ocrrec.job_id into v_recovery_job
  from public.source_page_article_inventory_jobs_v1 ij
  join public.source_page_ocr_recovery_receipts_v1 ocrrec
    on ocrrec.page_identity_source_image_id=ij.page_identity_source_image_id
   and ocrrec.source_image_id=ij.inventory_source_image_id
   and ocrrec.recovered_ocr_fingerprint=ij.source_ocr_json_sha256
   and ocrrec.status='passed'
  where ij.id=v_inventory_job;
  if v_recovery_job is null then raise exception 'ocr_segment_google_v14_recovery_blocks_missing'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'article_id',g.article_id,
    'crop_version',c.crop_version,
    'crop_spec_sha256',c.crop_spec_sha256,
    'crop_image_sha256',c.crop_image_sha256,
    'source_mode',c.source_mode,
    'source_image_sha256',c.source_image_sha256,
    'block_rects',(
      select jsonb_agg(jsonb_build_object(
        'block_index',b.block_index,
        'x_min',b.x_min,
        'y_min',b.y_min,
        'x_max',b.x_max,
        'y_max',b.y_max
      ) order by b.block_index)
      from public.source_inventory_block_assignments_v7 a
      join public.source_page_ocr_recovery_fresh_blocks_v1 b
        on b.job_id=v_recovery_job and b.block_index=a.block_index
      where a.inventory_job_id=v_inventory_job
        and a.article_id=g.article_id
        and a.assignment_kind='article'
        and a.assignment_version=g.block_partition_version
    )
  ) order by g.article_id::text),'[]'::jsonb) into v_articles
  from public.ocr_grounded_articles_for_partition_v1(src.partition_job_id) g
  join public.ocr_verification_crop_ocr_v4 c
    on c.job_id=src.id
   and c.article_id=g.article_id
   and c.crop_version='article_geometry_mask_composite_v3';

  if jsonb_array_length(v_articles)<>j.article_count then raise exception 'ocr_segment_google_v14_article_set_stale'; end if;
  if exists(
    select 1 from jsonb_array_elements(v_articles) x
    where jsonb_typeof(x->'block_rects')<>'array' or jsonb_array_length(x->'block_rects')=0
  ) then raise exception 'ocr_segment_google_v14_block_rects_missing'; end if;

  return jsonb_build_object(
    'job',jsonb_build_object('id',j.id,'source_job_id',j.source_job_id,'article_count',j.article_count,'is_canary',j.is_canary),
    'source',(
      select jsonb_build_object(
        'id',s.id,
        'storage_path',s.storage_path,
        'mime_type',s.mime_type,
        'width',s.width,
        'height',s.height,
        'file_name',s.file_name
      ) from public.source_images s where s.id=src.evidence_source_image_id
    ),
    'articles',v_articles
  );
end
$function$;

revoke all on function public.get_ocr_segment_google_canary_input_v14(uuid) from public, anon, authenticated;
grant execute on function public.get_ocr_segment_google_canary_input_v14(uuid) to postgres, service_role;

commit;

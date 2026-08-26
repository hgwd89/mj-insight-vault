-- V21 evidence must remain homogeneous within one job/pass/article.
-- Existing v11 consensus thresholds and decision semantics are unchanged.

create or replace function public.append_ocr_independent_piece_v18(
  p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_article_id uuid,p_sequence integer,p_segment_count integer,
  p_model text,p_segmentation_version text,p_segmentation_spec_sha256 text,p_segment_image_sha256 text,
  p_block_index integer,p_block_sequence integer,p_piece_sequence integer,p_piece_count integer,p_piece_kind text,
  p_source_left integer,p_source_top integer,p_source_right integer,p_source_bottom integer,
  p_transcription text,p_confidence numeric,p_proper_noun_status text,p_visual_proper_nouns text[],p_output_contract_status text,p_reason text,
  p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  j public.ocr_consensus_jobs_v11%rowtype;
  v_existing_model text;
begin
  select * into j from public.ocr_consensus_jobs_v11 where id=p_job_id for update;
  if not found or j.is_canary is distinct from true then raise exception 'ocr_consensus_v18_canary_only'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_consensus_v18_lease_invalid'; end if;
  if p_pass_kind not in ('sol','terra') or p_sequence<1 or p_segment_count<1 or p_sequence>p_segment_count then raise exception 'ocr_consensus_v18_piece_invalid'; end if;
  if p_block_index is null or p_block_sequence<1 or p_piece_sequence<1 or p_piece_count<1 or p_piece_sequence>p_piece_count then raise exception 'ocr_consensus_v18_piece_provenance_invalid'; end if;
  if p_piece_kind not in ('whole_block','vertical_segment','vertical_band','vertical_segment_band') then raise exception 'ocr_consensus_v18_piece_kind_invalid'; end if;
  if p_source_left<0 or p_source_top<0 or p_source_right<p_source_left or p_source_bottom<p_source_top then raise exception 'ocr_consensus_v18_piece_bounds_invalid'; end if;
  if coalesce(p_model,'')='' or coalesce(p_segmentation_version,'')='' then raise exception 'ocr_consensus_v18_model_or_version_missing'; end if;
  if coalesce(p_segmentation_spec_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_segment_image_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_prompt_sha256,'')!~'^[0-9a-f]{64}$' or coalesce(p_response_sha256,'')!~'^[0-9a-f]{64}$' then raise exception 'ocr_consensus_v18_hash_invalid'; end if;
  if coalesce(btrim(p_transcription),'')='' or p_confidence not between 0 and 1 then raise exception 'ocr_consensus_v18_transcription_invalid'; end if;
  if p_proper_noun_status not in ('passed','not_applicable','failed') or p_output_contract_status not in ('passed','failed') then raise exception 'ocr_consensus_v18_contract_invalid'; end if;
  if not exists(select 1 from public.ocr_verification_crop_ocr_v4 c where c.job_id=j.source_job_id and c.article_id=p_article_id and c.crop_version='article_geometry_mask_composite_v3') then raise exception 'ocr_consensus_v18_unknown_article'; end if;

  select model into v_existing_model from public.ocr_independent_segment_receipts_v16 where job_id=j.id and pass_kind=p_pass_kind limit 1;
  if v_existing_model is not null and v_existing_model<>p_model then raise exception 'ocr_consensus_v18_model_changed_within_pass'; end if;
  if exists(select 1 from public.ocr_independent_segment_receipts_v16 where job_id=j.id and pass_kind<>p_pass_kind and model=p_model) then raise exception 'ocr_consensus_v18_independent_model_required'; end if;

  if exists(
    select 1 from public.ocr_independent_segment_receipts_v16 r
    where r.job_id=j.id and r.pass_kind=p_pass_kind and r.article_id=p_article_id
      and r.segmentation_version is distinct from p_segmentation_version
  ) then raise exception 'ocr_consensus_v21_segmentation_version_changed_within_article_pass'; end if;
  if exists(
    select 1 from public.ocr_independent_segment_receipts_v16 r
    where r.job_id=j.id and r.pass_kind=p_pass_kind and r.article_id=p_article_id
      and r.segmentation_spec_sha256 is distinct from p_segmentation_spec_sha256
  ) then raise exception 'ocr_consensus_v21_segmentation_spec_changed_within_article_pass'; end if;
  if exists(
    select 1 from public.ocr_independent_segment_receipts_v16 r
    where r.job_id=j.id and r.pass_kind=p_pass_kind and r.article_id=p_article_id
      and r.segment_count is distinct from p_segment_count
  ) then raise exception 'ocr_consensus_v21_piece_count_changed_within_article_pass'; end if;

  insert into public.ocr_independent_segment_receipts_v16(
    job_id,pass_kind,article_id,sequence,segment_count,model,segmentation_version,segmentation_spec_sha256,segment_image_sha256,
    block_index,block_sequence,piece_sequence,piece_count,piece_kind,source_left,source_top,source_right,source_bottom,
    transcription,transcription_sha256,confidence,proper_noun_status,visual_proper_nouns,output_contract_status,reason,
    provider_response_id,prompt_sha256,response_sha256
  ) values(
    j.id,p_pass_kind,p_article_id,p_sequence,p_segment_count,p_model,p_segmentation_version,p_segmentation_spec_sha256,p_segment_image_sha256,
    p_block_index,p_block_sequence,p_piece_sequence,p_piece_count,p_piece_kind,p_source_left,p_source_top,p_source_right,p_source_bottom,
    p_transcription,encode(extensions.digest(convert_to(p_transcription,'UTF8'),'sha256'),'hex'),p_confidence,p_proper_noun_status,coalesce(p_visual_proper_nouns,'{}'::text[]),p_output_contract_status,left(coalesce(p_reason,''),1500),
    p_provider_response_id,p_prompt_sha256,p_response_sha256
  );
  return jsonb_build_object(
    'status','stored','article_id',p_article_id,'pass_kind',p_pass_kind,'sequence',p_sequence,
    'segment_count',p_segment_count,'segmentation_version',p_segmentation_version,
    'segmentation_spec_sha256',p_segmentation_spec_sha256,'block_index',p_block_index,
    'piece_sequence',p_piece_sequence,'piece_count',p_piece_count,'piece_kind',p_piece_kind
  );
end
$function$;

revoke all on function public.append_ocr_independent_piece_v18(uuid,uuid,text,uuid,integer,integer,text,text,text,text,integer,integer,integer,integer,text,integer,integer,integer,integer,text,numeric,text,text[],text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.append_ocr_independent_piece_v18(uuid,uuid,text,uuid,integer,integer,text,text,text,text,integer,integer,integer,integer,text,integer,integer,integer,integer,text,numeric,text,text[],text,text,text,text,text) to postgres,service_role;

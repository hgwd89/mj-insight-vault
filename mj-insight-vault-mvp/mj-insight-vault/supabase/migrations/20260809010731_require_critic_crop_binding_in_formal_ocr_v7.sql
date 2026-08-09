begin;

create or replace function public.validate_article_ocr_verification_consensus_v7()
returns trigger
language plpgsql
set search_path='pg_catalog','public','extensions'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  v_crop public.ocr_verification_crop_ocr_v4%rowtype;
  v_verifier public.ocr_verification_transcriptions_v2%rowtype;
  v_critic public.ocr_verification_transcriptions_v2%rowtype;
  v_vchunk public.ocr_verification_vision_chunks_v4%rowtype;
  v_cchunk public.ocr_verification_vision_chunks_v4%rowtype;
  v_binding text;
begin
  if new.verification_version<>'article_ocr_verification_v5_crop_ocr_plus_independent_vision' or new.quality_status<>'passed' then return new; end if;
  select * into j from public.ocr_verification_page_jobs_v2 where partition_job_id=new.partition_job_id;
  if not found or j.status not in ('running','completed') then raise exception 'ocr_verification_v7_page_job_missing'; end if;
  select * into v_crop from public.ocr_verification_crop_ocr_v4 where job_id=j.id and article_id=new.article_id;
  if not found or new.canonical_text<>v_crop.crop_ocr_text or new.canonical_text_sha256<>v_crop.crop_ocr_text_sha256 then raise exception 'ocr_verification_v7_canonical_not_crop_ocr'; end if;

  select * into v_verifier from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='verifier' and article_id=new.article_id;
  if not found or v_verifier.vision_chunk_id is null then raise exception 'ocr_verification_v7_verifier_missing'; end if;
  select * into v_vchunk from public.ocr_verification_vision_chunks_v4 where id=v_verifier.vision_chunk_id;
  if not found or v_vchunk.job_id<>j.id or v_vchunk.pass_kind<>'verifier' then raise exception 'ocr_verification_v7_verifier_chunk_invalid'; end if;
  select encode(extensions.digest(convert_to(string_agg(t.article_id::text||':'||c.crop_spec_sha256||':'||c.crop_image_sha256||':'||c.source_mode||':'||c.source_image_sha256,'|' order by t.article_id::text),'UTF8'),'sha256'),'hex') into v_binding
  from public.ocr_verification_transcriptions_v2 t join public.ocr_verification_crop_ocr_v4 c on c.job_id=t.job_id and c.article_id=t.article_id where t.vision_chunk_id=v_vchunk.id;
  if v_binding is distinct from v_vchunk.input_binding_sha256 then raise exception 'ocr_verification_v7_verifier_binding_mismatch'; end if;
  if new.independent_model<>v_vchunk.model or new.independent_response_id<>v_vchunk.provider_response_id or new.independent_prompt_sha256<>v_vchunk.prompt_sha256 or new.independent_response_sha256<>v_vchunk.response_sha256 then raise exception 'ocr_verification_v7_verifier_receipt_mismatch'; end if;

  if j.requires_second_pass then
    select * into v_critic from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='critic' and article_id=new.article_id;
    if not found or v_critic.vision_chunk_id is null then raise exception 'ocr_verification_v7_critic_missing'; end if;
    select * into v_cchunk from public.ocr_verification_vision_chunks_v4 where id=v_critic.vision_chunk_id;
    if not found or v_cchunk.job_id<>j.id or v_cchunk.pass_kind<>'critic' then raise exception 'ocr_verification_v7_critic_chunk_invalid'; end if;
    select encode(extensions.digest(convert_to(string_agg(t.article_id::text||':'||c.crop_spec_sha256||':'||c.crop_image_sha256||':'||c.source_mode||':'||c.source_image_sha256,'|' order by t.article_id::text),'UTF8'),'sha256'),'hex') into v_binding
    from public.ocr_verification_transcriptions_v2 t join public.ocr_verification_crop_ocr_v4 c on c.job_id=t.job_id and c.article_id=t.article_id where t.vision_chunk_id=v_cchunk.id;
    if v_binding is distinct from v_cchunk.input_binding_sha256 then raise exception 'ocr_verification_v7_critic_binding_mismatch'; end if;
    if v_cchunk.model=v_vchunk.model or v_cchunk.provider_response_id=v_vchunk.provider_response_id or v_cchunk.prompt_sha256=v_vchunk.prompt_sha256 then raise exception 'ocr_verification_v7_independent_critic_required'; end if;
  end if;
  return new;
end
$function$;

drop trigger if exists validate_article_ocr_verification_consensus_v6 on public.article_ocr_verifications_v1;
drop trigger if exists validate_article_ocr_verification_consensus_v7 on public.article_ocr_verifications_v1;
create trigger validate_article_ocr_verification_consensus_v7 before insert or update on public.article_ocr_verifications_v1 for each row execute function public.validate_article_ocr_verification_consensus_v7();

commit;
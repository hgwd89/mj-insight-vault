begin;

create or replace function public.validate_ocr_verification_transcription_v3()
returns trigger
language plpgsql
set search_path=pg_catalog,public
as $function$
declare v_noun text;
begin
  if new.proper_noun_status='passed' and cardinality(new.visual_proper_nouns)=0 then
    raise exception 'ocr_verification_v3_passed_proper_nouns_required';
  end if;
  if new.proper_noun_status='not_applicable' and cardinality(new.visual_proper_nouns)<>0 then
    raise exception 'ocr_verification_v3_not_applicable_proper_nouns_must_be_empty';
  end if;
  foreach v_noun in array new.visual_proper_nouns loop
    if coalesce(btrim(v_noun),'')='' or position(lower(v_noun) in lower(new.transcription))=0 then
      raise exception 'ocr_verification_v3_proper_noun_not_in_visual_transcription';
    end if;
  end loop;
  return new;
end
$function$;

drop trigger if exists trg_validate_ocr_verification_transcription_v3 on public.ocr_verification_transcriptions_v2;
create trigger trg_validate_ocr_verification_transcription_v3
before insert or update on public.ocr_verification_transcriptions_v2
for each row execute function public.validate_ocr_verification_transcription_v3();
revoke all on function public.validate_ocr_verification_transcription_v3() from public,anon,authenticated;

create or replace function public.validate_article_ocr_verification_consensus_v3()
returns trigger
language plpgsql
set search_path=pg_catalog,public,extensions
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  v_source text;
  v_source_norm text;
  v_verify text;
  v_verify_norm text;
  v_critic text;
  v_critic_norm text;
  v_quality text;
  v_source_len integer;
  v_verify_len integer;
  v_critic_len integer;
begin
  if new.verification_version<>'article_ocr_verification_v2_independent_page_vision' or new.quality_status<>'passed' then
    return new;
  end if;

  select * into j from public.ocr_verification_page_jobs_v2 where partition_job_id=new.partition_job_id;
  if not found then raise exception 'ocr_verification_v3_page_job_missing'; end if;

  select g.source_region_text,q.region_quality_status into v_source,v_quality
  from public.formal_source_grounded_articles_v6 g
  join public.article_region_ocr_quality_v1 q on q.article_id=g.article_id and q.source_region_id=g.source_region_id
  where g.article_id=new.article_id and g.source_region_id=new.source_region_id and g.partition_job_id=new.partition_job_id;
  if v_source is null then raise exception 'ocr_verification_v3_source_region_missing'; end if;

  select transcription into v_verify
  from public.ocr_verification_transcriptions_v2
  where job_id=j.id and pass_kind='verifier' and article_id=new.article_id;
  if v_verify is null then raise exception 'ocr_verification_v3_verifier_transcription_missing'; end if;

  if j.requires_second_pass then
    select transcription into v_critic
    from public.ocr_verification_transcriptions_v2
    where job_id=j.id and pass_kind='critic' and article_id=new.article_id;
    if v_critic is null then raise exception 'ocr_verification_v3_critic_transcription_missing'; end if;
  end if;

  v_source_norm:=public.normalize_ocr_consensus_text_v2(v_source);
  v_verify_norm:=public.normalize_ocr_consensus_text_v2(v_verify);
  v_critic_norm:=public.normalize_ocr_consensus_text_v2(coalesce(v_critic,v_verify));
  v_source_len:=char_length(v_source_norm);
  v_verify_len:=char_length(v_verify_norm);
  v_critic_len:=char_length(v_critic_norm);

  if v_source_len=0 or v_verify_len=0 then raise exception 'ocr_verification_v3_empty_normalized_text'; end if;
  if not (v_verify_len::numeric/nullif(v_source_len,0) between 0.90 and 1.10) then
    raise exception 'ocr_verification_v3_verifier_length_ratio_failed';
  end if;
  if j.requires_second_pass and not (v_critic_len::numeric/nullif(v_source_len,0) between 0.90 and 1.10) then
    raise exception 'ocr_verification_v3_critic_length_ratio_failed';
  end if;

  if similarity(v_source_norm,v_verify_norm)<(case when v_quality='strong' then 0.90 else 0.86 end) then
    raise exception 'ocr_verification_v3_verifier_similarity_failed';
  end if;
  if j.requires_second_pass and (
    similarity(v_source_norm,v_critic_norm)<(case when v_quality='strong' then 0.90 else 0.86 end)
    or similarity(v_verify_norm,v_critic_norm)<0.90
  ) then
    raise exception 'ocr_verification_v3_critic_similarity_failed';
  end if;

  if public.ocr_numeric_tokens_v2(v_source)<>public.ocr_numeric_tokens_v2(v_verify)
     or (j.requires_second_pass and public.ocr_numeric_tokens_v2(v_source)<>public.ocr_numeric_tokens_v2(v_critic)) then
    raise exception 'ocr_verification_v3_numeric_mismatch';
  end if;

  return new;
end
$function$;

drop trigger if exists trg_validate_article_ocr_verification_consensus_v3 on public.article_ocr_verifications_v1;
create trigger trg_validate_article_ocr_verification_consensus_v3
before insert or update on public.article_ocr_verifications_v1
for each row execute function public.validate_article_ocr_verification_consensus_v3();
revoke all on function public.validate_article_ocr_verification_consensus_v3() from public,anon,authenticated;

commit;
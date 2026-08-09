begin;

create or replace function public.finalize_ocr_verification_page_job_v2(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;v_bad integer;v_rows integer;
begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_verification_v5_lease_invalid'; end if;
 if not exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id) then raise exception 'ocr_verification_v5_freeze_stale'; end if;
 if (select count(*) from public.ocr_verification_crop_ocr_v4 where job_id=j.id)<>j.article_count then raise exception 'ocr_verification_v5_crop_ocr_incomplete'; end if;
 if (select count(*) from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='verifier')<>j.article_count then raise exception 'ocr_verification_v5_verifier_incomplete'; end if;
 if j.requires_second_pass and (select count(*) from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='critic')<>j.article_count then raise exception 'ocr_verification_v5_critic_incomplete'; end if;
 if not j.requires_second_pass and exists(select 1 from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='critic') then raise exception 'ocr_verification_v5_unexpected_critic'; end if;
 if exists(select 1 from public.ocr_verification_transcriptions_v2 where job_id=j.id and vision_chunk_id is null) then raise exception 'ocr_verification_v5_unreceipted_transcription'; end if;
 if (select coalesce(sum(article_count),0) from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind='verifier')<>j.article_count then raise exception 'ocr_verification_v5_verifier_chunk_receipts_incomplete'; end if;
 if j.requires_second_pass and (select coalesce(sum(article_count),0) from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind='critic')<>j.article_count then raise exception 'ocr_verification_v5_critic_chunk_receipts_incomplete'; end if;
 if j.requires_second_pass and exists(select 1 from public.ocr_verification_vision_chunks_v4 v join public.ocr_verification_vision_chunks_v4 c on c.job_id=v.job_id and c.pass_kind='critic' where v.job_id=j.id and v.pass_kind='verifier' and v.model=c.model) then raise exception 'ocr_verification_v5_models_not_independent'; end if;
 with checks as (
   select g.article_id,q.region_quality_status,g.source_region_text,crop.crop_ocr_text,
          v.transcription verifier_text,v.proper_noun_status verifier_pn,v.visual_proper_nouns verifier_nouns,
          c.transcription critic_text,c.proper_noun_status critic_pn,c.visual_proper_nouns critic_nouns,
          similarity(public.normalize_ocr_consensus_text_v2(crop.crop_ocr_text),public.normalize_ocr_consensus_text_v2(v.transcription)) verifier_crop_sim,
          case when c.article_id is null then 1::real else similarity(public.normalize_ocr_consensus_text_v2(crop.crop_ocr_text),public.normalize_ocr_consensus_text_v2(c.transcription)) end critic_crop_sim,
          case when c.article_id is null then 1::real else similarity(public.normalize_ocr_consensus_text_v2(v.transcription),public.normalize_ocr_consensus_text_v2(c.transcription)) end interpass_sim,
          similarity(public.normalize_ocr_consensus_text_v2(g.source_region_text),public.normalize_ocr_consensus_text_v2(crop.crop_ocr_text)) page_crop_sim,
          public.ocr_numeric_tokens_v2(crop.crop_ocr_text)=public.ocr_numeric_tokens_v2(v.transcription) verifier_numbers,
          case when c.article_id is null then true else public.ocr_numeric_tokens_v2(crop.crop_ocr_text)=public.ocr_numeric_tokens_v2(c.transcription) end critic_numbers,
          not exists(select 1 from unnest(v.visual_proper_nouns) n where position(public.normalize_ocr_consensus_text_v2(n) in public.normalize_ocr_consensus_text_v2(crop.crop_ocr_text))=0) verifier_nouns_in_crop,
          case when c.article_id is null then true else not exists(select 1 from unnest(c.visual_proper_nouns) n where position(public.normalize_ocr_consensus_text_v2(n) in public.normalize_ocr_consensus_text_v2(crop.crop_ocr_text))=0) end critic_nouns_in_crop,
          char_length(public.normalize_ocr_consensus_text_v2(v.transcription))::numeric/nullif(char_length(public.normalize_ocr_consensus_text_v2(crop.crop_ocr_text)),0) verifier_len_ratio,
          case when c.article_id is null then 1::numeric else char_length(public.normalize_ocr_consensus_text_v2(c.transcription))::numeric/nullif(char_length(public.normalize_ocr_consensus_text_v2(crop.crop_ocr_text)),0) end critic_len_ratio
   from public.formal_source_grounded_articles_v6 g
   join public.article_region_ocr_quality_v1 q on q.article_id=g.article_id and q.source_region_id=g.source_region_id
   join public.ocr_verification_crop_ocr_v4 crop on crop.job_id=j.id and crop.article_id=g.article_id
   join public.ocr_verification_transcriptions_v2 v on v.job_id=j.id and v.pass_kind='verifier' and v.article_id=g.article_id
   left join public.ocr_verification_transcriptions_v2 c on c.job_id=j.id and c.pass_kind='critic' and c.article_id=g.article_id
   where g.partition_job_id=j.partition_job_id
 )
 select count(*) filter(where verifier_crop_sim<0.90 or critic_crop_sim<0.90 or interpass_sim<0.90 or page_crop_sim<0.70 or not verifier_numbers or not critic_numbers or not verifier_nouns_in_crop or not critic_nouns_in_crop or verifier_pn='failed' or coalesce(critic_pn,'passed')='failed' or not (verifier_len_ratio between 0.90 and 1.10) or not (critic_len_ratio between 0.90 and 1.10))::integer,
        count(*)::integer into v_bad,v_rows from checks;
 if v_rows<>j.article_count or v_bad>0 then
   update public.ocr_verification_page_jobs_v2 set status='needs_review',lease_token=null,lease_expires_at=null,error_message=format('crop OCR / independent vision consensus failed: rows=%s expected=%s bad=%s',v_rows,j.article_count,v_bad),updated_at=now() where id=j.id;
   return jsonb_build_object('status','needs_review','rows',v_rows,'bad_articles',v_bad);
 end if;
 insert into public.article_ocr_verifications_v1(
   article_id,source_region_id,partition_job_id,verification_version,region_quality_status,verification_mode,canonical_text,canonical_text_sha256,
   source_region_sha256,source_ocr_sha256,numeric_verification_status,proper_noun_verification_status,
   independent_provider,independent_model,independent_response_id,independent_prompt_sha256,independent_response_sha256,
   quality_status,quality_reason,verified_at,updated_at
 )
 select g.article_id,g.source_region_id,g.partition_job_id,'article_ocr_verification_v5_crop_ocr_plus_independent_vision',q.region_quality_status,'crop_ocr_consensus',
        crop.crop_ocr_text,crop.crop_ocr_text_sha256,g.source_region_sha256,g.current_source_raw_ocr_sha256,
        case when cardinality(public.ocr_numeric_tokens_v2(crop.crop_ocr_text))=0 then 'not_applicable' else 'passed' end,
        case when v.proper_noun_status='not_applicable' and (c.article_id is null or c.proper_noun_status='not_applicable') then 'not_applicable' else 'passed' end,
        'openai',vc.model,vc.provider_response_id,vc.prompt_sha256,vc.response_sha256,'passed',
        case when j.requires_second_pass then 'Article-block crop Google OCR confirmed by two distinct independent Vision passes; verifier receipt is article-specific' else 'Article-block crop Google OCR confirmed by independent Vision; verifier receipt is article-specific' end,now(),now()
 from public.formal_source_grounded_articles_v6 g
 join public.article_region_ocr_quality_v1 q on q.article_id=g.article_id and q.source_region_id=g.source_region_id
 join public.ocr_verification_crop_ocr_v4 crop on crop.job_id=j.id and crop.article_id=g.article_id
 join public.ocr_verification_transcriptions_v2 v on v.job_id=j.id and v.pass_kind='verifier' and v.article_id=g.article_id
 join public.ocr_verification_vision_chunks_v4 vc on vc.id=v.vision_chunk_id and vc.job_id=j.id and vc.pass_kind='verifier'
 left join public.ocr_verification_transcriptions_v2 c on c.job_id=j.id and c.pass_kind='critic' and c.article_id=g.article_id
 where g.partition_job_id=j.partition_job_id
 on conflict(article_id) do update set source_region_id=excluded.source_region_id,partition_job_id=excluded.partition_job_id,verification_version=excluded.verification_version,region_quality_status=excluded.region_quality_status,verification_mode=excluded.verification_mode,canonical_text=excluded.canonical_text,canonical_text_sha256=excluded.canonical_text_sha256,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,numeric_verification_status=excluded.numeric_verification_status,proper_noun_verification_status=excluded.proper_noun_verification_status,independent_provider=excluded.independent_provider,independent_model=excluded.independent_model,independent_response_id=excluded.independent_response_id,independent_prompt_sha256=excluded.independent_prompt_sha256,independent_response_sha256=excluded.independent_response_sha256,quality_status='passed',quality_reason=excluded.quality_reason,verified_at=now(),updated_at=now();
 update public.ocr_verification_page_jobs_v2 set status='completed',lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
 return jsonb_build_object('status','completed','article_count',j.article_count,'second_pass',j.requires_second_pass,'canonical_source','article_block_crop_google_ocr','article_receipts','per_verifier_chunk');
end
$function$;

create or replace function public.validate_article_ocr_verification_consensus_v5()
returns trigger language plpgsql set search_path=pg_catalog,public,extensions
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;v_crop public.ocr_verification_crop_ocr_v4%rowtype;v_t public.ocr_verification_transcriptions_v2%rowtype;v_chunk public.ocr_verification_vision_chunks_v4%rowtype;
begin
 if new.verification_version<>'article_ocr_verification_v5_crop_ocr_plus_independent_vision' or new.quality_status<>'passed' then return new; end if;
 select * into j from public.ocr_verification_page_jobs_v2 where partition_job_id=new.partition_job_id;
 if not found or j.status not in ('running','completed') then raise exception 'ocr_verification_v5_page_job_missing'; end if;
 select * into v_crop from public.ocr_verification_crop_ocr_v4 where job_id=j.id and article_id=new.article_id;
 if not found or new.canonical_text<>v_crop.crop_ocr_text or new.canonical_text_sha256<>v_crop.crop_ocr_text_sha256 then raise exception 'ocr_verification_v5_canonical_not_crop_ocr'; end if;
 select * into v_t from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='verifier' and article_id=new.article_id;
 if not found or v_t.vision_chunk_id is null then raise exception 'ocr_verification_v5_article_verifier_missing'; end if;
 select * into v_chunk from public.ocr_verification_vision_chunks_v4 where id=v_t.vision_chunk_id;
 if not found or v_chunk.job_id<>j.id or v_chunk.pass_kind<>'verifier' then raise exception 'ocr_verification_v5_article_chunk_invalid'; end if;
 if new.independent_model<>v_chunk.model or new.independent_response_id<>v_chunk.provider_response_id or new.independent_prompt_sha256<>v_chunk.prompt_sha256 or new.independent_response_sha256<>v_chunk.response_sha256 then raise exception 'ocr_verification_v5_article_receipt_mismatch'; end if;
 return new;
end
$function$;

drop trigger if exists trg_validate_article_ocr_verification_consensus_v3 on public.article_ocr_verifications_v1;
drop trigger if exists trg_validate_article_ocr_verification_consensus_v5 on public.article_ocr_verifications_v1;
create trigger trg_validate_article_ocr_verification_consensus_v5
before insert or update on public.article_ocr_verifications_v1
for each row execute function public.validate_article_ocr_verification_consensus_v5();
revoke all on function public.validate_article_ocr_verification_consensus_v5() from public,anon,authenticated;

commit;
begin;

create table public.ocr_verification_vision_chunks_v4(
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ocr_verification_page_jobs_v2(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('verifier','critic')),
  chunk_index integer not null check(chunk_index>=0),
  model text not null,
  provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  article_set_fingerprint text not null check(article_set_fingerprint ~ '^[0-9a-f]{64}$'),
  article_count integer not null check(article_count>0),
  created_at timestamptz not null default now(),
  unique(job_id,pass_kind,chunk_index)
);
alter table public.ocr_verification_vision_chunks_v4 enable row level security;
revoke all on public.ocr_verification_vision_chunks_v4 from public,anon,authenticated,service_role;
grant select on public.ocr_verification_vision_chunks_v4 to service_role;

alter table public.ocr_verification_transcriptions_v2
  add column if not exists vision_chunk_id uuid references public.ocr_verification_vision_chunks_v4(id) on delete cascade;
create index if not exists ocr_verification_transcriptions_v2_chunk_idx on public.ocr_verification_transcriptions_v2(vision_chunk_id);

create or replace function public.append_ocr_verification_vision_chunk_v4(
 p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_chunk_index integer,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;r jsonb;v_count integer;v_fp text;v_chunk_id uuid;v_existing_model text;
begin
 if p_pass_kind not in ('verifier','critic') or p_chunk_index<0 then raise exception 'ocr_vision_v4_bad_chunk'; end if;
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_vision_v4_lease_invalid'; end if;
 if p_pass_kind='critic' and not j.requires_second_pass then raise exception 'ocr_vision_v4_critic_not_required'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<1 then raise exception 'ocr_vision_v4_rows_required'; end if;
 select model into v_existing_model from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind=p_pass_kind limit 1;
 if v_existing_model is not null and v_existing_model<>p_model then raise exception 'ocr_vision_v4_model_changed_within_pass'; end if;
 if exists(select 1 from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind<>p_pass_kind and model=p_model) then raise exception 'ocr_vision_v4_independent_model_required'; end if;
 if exists(select 1 from public.ocr_verification_vision_chunks_v4 where provider_response_id=p_provider_response_id or prompt_sha256=p_prompt_sha256) then raise exception 'ocr_vision_v4_independent_receipt_required'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text) group by article_id having count(*)>1) then raise exception 'ocr_vision_v4_duplicate_article_in_chunk'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text) where not exists(select 1 from public.formal_source_grounded_articles_v6 g where g.partition_job_id=j.partition_job_id and g.article_id=x.article_id)) then raise exception 'ocr_vision_v4_unknown_article'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text) where exists(select 1 from public.ocr_verification_transcriptions_v2 t where t.job_id=j.id and t.pass_kind=p_pass_kind and t.article_id=x.article_id)) then raise exception 'ocr_vision_v4_article_already_transcribed'; end if;
 select count(*)::integer,encode(extensions.digest(convert_to(string_agg(article_id::text,'|' order by article_id::text),'UTF8'),'sha256'),'hex') into v_count,v_fp
 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text);
 if v_count<>jsonb_array_length(p_rows) then raise exception 'ocr_vision_v4_chunk_count_mismatch'; end if;
 insert into public.ocr_verification_vision_chunks_v4(job_id,pass_kind,chunk_index,model,provider_response_id,prompt_sha256,response_sha256,article_set_fingerprint,article_count)
 values(j.id,p_pass_kind,p_chunk_index,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256,v_fp,v_count)
 returning id into v_chunk_id;
 for r in select value from jsonb_array_elements(p_rows) loop
   if coalesce(btrim(r->>'transcription'),'')='' then raise exception 'ocr_vision_v4_empty_transcription'; end if;
   if coalesce((r->>'confidence')::numeric,0)<0.85 then raise exception 'ocr_vision_v4_low_confidence'; end if;
   if coalesce(r->>'proper_noun_status','') not in ('passed','not_applicable','failed') then raise exception 'ocr_vision_v4_bad_proper_noun_status'; end if;
   insert into public.ocr_verification_transcriptions_v2(job_id,pass_kind,article_id,transcription,transcription_sha256,confidence,proper_noun_status,visual_proper_nouns,reason,vision_chunk_id)
   values(j.id,p_pass_kind,(r->>'article_id')::uuid,r->>'transcription',encode(extensions.digest(convert_to(r->>'transcription','UTF8'),'sha256'),'hex'),(r->>'confidence')::numeric,r->>'proper_noun_status',coalesce(array(select jsonb_array_elements_text(coalesce(r->'visual_proper_nouns','[]'::jsonb))),'{}'::text[]),left(coalesce(r->>'reason',''),1000),v_chunk_id);
 end loop;
 return jsonb_build_object('status','stored','chunk_id',v_chunk_id,'chunk_rows',v_count,'pass_kind',p_pass_kind);
end
$function$;
revoke all on function public.append_ocr_verification_vision_chunk_v4(uuid,uuid,text,integer,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.append_ocr_verification_vision_chunk_v4(uuid,uuid,text,integer,text,text,text,text,jsonb) to service_role;
revoke execute on function public.replace_ocr_verification_pass_v2(uuid,uuid,text,text,text,text,text,jsonb) from service_role;

create or replace function public.finalize_ocr_verification_page_job_v2(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;v_bad integer;v_rows integer;v_verifier_model text;v_verifier_response text;v_verifier_prompt text;v_verifier_response_sha text;
begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_verification_v4_lease_invalid'; end if;
 if not exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id) then raise exception 'ocr_verification_v4_freeze_stale'; end if;
 if (select count(*) from public.ocr_verification_crop_ocr_v4 where job_id=j.id)<>j.article_count then raise exception 'ocr_verification_v4_crop_ocr_incomplete'; end if;
 if (select count(*) from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='verifier')<>j.article_count then raise exception 'ocr_verification_v4_verifier_incomplete'; end if;
 if j.requires_second_pass and (select count(*) from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='critic')<>j.article_count then raise exception 'ocr_verification_v4_critic_incomplete'; end if;
 if not j.requires_second_pass and exists(select 1 from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='critic') then raise exception 'ocr_verification_v4_unexpected_critic'; end if;
 if exists(select 1 from public.ocr_verification_transcriptions_v2 where job_id=j.id and vision_chunk_id is null) then raise exception 'ocr_verification_v4_unreceipted_transcription'; end if;
 if (select coalesce(sum(article_count),0) from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind='verifier')<>j.article_count then raise exception 'ocr_verification_v4_verifier_chunk_receipts_incomplete'; end if;
 if j.requires_second_pass and (select coalesce(sum(article_count),0) from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind='critic')<>j.article_count then raise exception 'ocr_verification_v4_critic_chunk_receipts_incomplete'; end if;
 if j.requires_second_pass and exists(select 1 from public.ocr_verification_vision_chunks_v4 v join public.ocr_verification_vision_chunks_v4 c on c.job_id=v.job_id and c.pass_kind='critic' where v.job_id=j.id and v.pass_kind='verifier' and v.model=c.model) then raise exception 'ocr_verification_v4_models_not_independent'; end if;
 select model,provider_response_id,prompt_sha256,response_sha256 into v_verifier_model,v_verifier_response,v_verifier_prompt,v_verifier_response_sha from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind='verifier' order by chunk_index limit 1;
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
 insert into public.article_ocr_verifications_v1(article_id,source_region_id,partition_job_id,verification_version,region_quality_status,verification_mode,canonical_text,canonical_text_sha256,source_region_sha256,source_ocr_sha256,numeric_verification_status,proper_noun_verification_status,independent_provider,independent_model,independent_response_id,independent_prompt_sha256,independent_response_sha256,quality_status,quality_reason,verified_at,updated_at)
 select g.article_id,g.source_region_id,g.partition_job_id,'article_ocr_verification_v4_crop_ocr_plus_independent_vision',q.region_quality_status,'crop_ocr_consensus',crop.crop_ocr_text,crop.crop_ocr_text_sha256,g.source_region_sha256,g.current_source_raw_ocr_sha256,case when cardinality(public.ocr_numeric_tokens_v2(crop.crop_ocr_text))=0 then 'not_applicable' else 'passed' end,case when v.proper_noun_status='not_applicable' and (c.article_id is null or c.proper_noun_status='not_applicable') then 'not_applicable' else 'passed' end,'openai',v_verifier_model,v_verifier_response,v_verifier_prompt,v_verifier_response_sha,'passed',case when j.requires_second_pass then 'Article-block crop Google OCR confirmed by two distinct independent Vision passes; full-page OCR lineage retained' else 'Article-block crop Google OCR confirmed by independent Vision; full-page OCR lineage retained' end,now(),now()
 from public.formal_source_grounded_articles_v6 g join public.article_region_ocr_quality_v1 q on q.article_id=g.article_id and q.source_region_id=g.source_region_id join public.ocr_verification_crop_ocr_v4 crop on crop.job_id=j.id and crop.article_id=g.article_id join public.ocr_verification_transcriptions_v2 v on v.job_id=j.id and v.pass_kind='verifier' and v.article_id=g.article_id left join public.ocr_verification_transcriptions_v2 c on c.job_id=j.id and c.pass_kind='critic' and c.article_id=g.article_id where g.partition_job_id=j.partition_job_id
 on conflict(article_id) do update set source_region_id=excluded.source_region_id,partition_job_id=excluded.partition_job_id,verification_version=excluded.verification_version,region_quality_status=excluded.region_quality_status,verification_mode=excluded.verification_mode,canonical_text=excluded.canonical_text,canonical_text_sha256=excluded.canonical_text_sha256,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,numeric_verification_status=excluded.numeric_verification_status,proper_noun_verification_status=excluded.proper_noun_verification_status,independent_provider=excluded.independent_provider,independent_model=excluded.independent_model,independent_response_id=excluded.independent_response_id,independent_prompt_sha256=excluded.independent_prompt_sha256,independent_response_sha256=excluded.independent_response_sha256,quality_status='passed',quality_reason=excluded.quality_reason,verified_at=now(),updated_at=now();
 update public.ocr_verification_page_jobs_v2 set status='completed',lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
 return jsonb_build_object('status','completed','article_count',j.article_count,'second_pass',j.requires_second_pass,'canonical_source','article_block_crop_google_ocr');
end
$function$;

create or replace function public.requeue_ocr_verification_page_job_v2(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status not in ('needs_review','failed') then raise exception 'ocr_verification_v4_requeue_not_allowed'; end if;
 if not exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id) then raise exception 'ocr_verification_v4_freeze_stale'; end if;
 delete from public.article_ocr_verifications_v1 where partition_job_id=j.partition_job_id;
 delete from public.ocr_verification_transcriptions_v2 where job_id=j.id;
 delete from public.ocr_verification_vision_chunks_v4 where job_id=j.id;
 delete from public.ocr_verification_pass_runs_v2 where job_id=j.id;
 delete from public.ocr_verification_crop_ocr_v4 where job_id=j.id;
 update public.ocr_verification_page_jobs_v2 set status='queued',failure_count=0,lease_token=null,lease_expires_at=null,error_message=null,finished_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','queued','proofs_reset',true);
end
$function$;

commit;
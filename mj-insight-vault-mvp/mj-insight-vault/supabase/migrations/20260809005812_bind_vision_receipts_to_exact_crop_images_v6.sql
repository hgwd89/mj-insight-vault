begin;

alter table public.ocr_verification_crop_ocr_v4
  add column source_mode text,
  add column source_image_sha256 text;

alter table public.ocr_verification_crop_ocr_v4
  add constraint ocr_verification_crop_ocr_v4_source_mode_chk check(source_mode in ('verified_original','ocr_derivative')),
  add constraint ocr_verification_crop_ocr_v4_source_image_sha_chk check(source_image_sha256 ~ '^[0-9a-f]{64}$');

alter table public.ocr_verification_crop_ocr_v4
  alter column source_mode set not null,
  alter column source_image_sha256 set not null;

alter table public.ocr_verification_vision_chunks_v4
  add column input_binding_sha256 text;
alter table public.ocr_verification_vision_chunks_v4
  add constraint ocr_verification_vision_chunks_v4_input_binding_chk check(input_binding_sha256 ~ '^[0-9a-f]{64}$');
alter table public.ocr_verification_vision_chunks_v4
  alter column input_binding_sha256 set not null;

create or replace function public.replace_ocr_crop_results_v6(p_job_id uuid,p_lease_token uuid,p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  r jsonb;
  p public.source_image_ingest_provenance_v2%rowtype;
  v_input integer;
  v_total integer;
  v_mode text;
  v_sha text;
begin
  select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_crop_v6_lease_invalid'; end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<1 then raise exception 'ocr_crop_v6_rows_required'; end if;
  select * into p from public.source_image_ingest_provenance_v2 where source_image_id=j.evidence_source_image_id;
  v_input:=jsonb_array_length(p_rows);
  for r in select value from jsonb_array_elements(p_rows) loop
    if not exists(select 1 from public.formal_source_grounded_articles_v6 g where g.partition_job_id=j.partition_job_id and g.article_id=(r->>'article_id')::uuid) then raise exception 'ocr_crop_v6_unknown_article'; end if;
    if coalesce(btrim(r->>'crop_ocr_text'),'')='' then raise exception 'ocr_crop_v6_empty_text'; end if;
    if coalesce(r->>'crop_spec_sha256','')!~'^[0-9a-f]{64}$' or coalesce(r->>'crop_image_sha256','')!~'^[0-9a-f]{64}$' or coalesce(r->>'google_response_sha256','')!~'^[0-9a-f]{64}$' then raise exception 'ocr_crop_v6_receipt_invalid'; end if;
    v_mode:=coalesce(r->>'source_mode',''); v_sha:=coalesce(r->>'source_image_sha256','');
    if v_mode not in ('verified_original','ocr_derivative') or v_sha!~'^[0-9a-f]{64}$' then raise exception 'ocr_crop_v6_source_binding_invalid'; end if;
    if v_mode='verified_original' then
      if p.source_image_id is null or p.quality_status<>'passed' or not p.original_available or p.original_verified_at is null or p.original_sha256 is distinct from v_sha then raise exception 'ocr_crop_v6_original_binding_invalid'; end if;
    elsif p.source_image_id is not null and p.quality_status='passed' and coalesce(p.ocr_derivative_sha256,'')~'^[0-9a-f]{64}$' and p.ocr_derivative_sha256 is distinct from v_sha then
      raise exception 'ocr_crop_v6_derivative_binding_invalid';
    end if;
    insert into public.ocr_verification_crop_ocr_v4(job_id,article_id,crop_version,crop_spec_sha256,crop_image_sha256,google_response_sha256,crop_ocr_text,crop_ocr_text_sha256,source_mode,source_image_sha256)
    values(j.id,(r->>'article_id')::uuid,'article_block_mask_composite_v2',r->>'crop_spec_sha256',r->>'crop_image_sha256',r->>'google_response_sha256',r->>'crop_ocr_text',encode(extensions.digest(convert_to(r->>'crop_ocr_text','UTF8'),'sha256'),'hex'),v_mode,v_sha)
    on conflict(job_id,article_id) do update set crop_version='article_block_mask_composite_v2',crop_spec_sha256=excluded.crop_spec_sha256,crop_image_sha256=excluded.crop_image_sha256,google_response_sha256=excluded.google_response_sha256,crop_ocr_text=excluded.crop_ocr_text,crop_ocr_text_sha256=excluded.crop_ocr_text_sha256,source_mode=excluded.source_mode,source_image_sha256=excluded.source_image_sha256,created_at=now();
  end loop;
  select count(*)::integer into v_total from public.ocr_verification_crop_ocr_v4 where job_id=j.id;
  if v_total>j.article_count then raise exception 'ocr_crop_v6_article_count_overflow'; end if;
  return jsonb_build_object('status','stored','chunk_rows',v_input,'total_rows',v_total,'expected_rows',j.article_count,'complete',v_total=j.article_count,'crop_version','article_block_mask_composite_v2');
end
$function$;

create or replace function public.append_ocr_verification_vision_chunk_v6(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_chunk_index integer,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_input_binding_sha256 text,p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare
 j public.ocr_verification_page_jobs_v2%rowtype; r jsonb; v_count integer; v_fp text; v_binding text; v_chunk_id uuid; v_existing_model text;
begin
 if p_pass_kind not in ('verifier','critic') or p_chunk_index<0 then raise exception 'ocr_vision_v6_bad_chunk'; end if;
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_vision_v6_lease_invalid'; end if;
 if p_pass_kind='critic' and not j.requires_second_pass then raise exception 'ocr_vision_v6_critic_not_required'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<1 then raise exception 'ocr_vision_v6_rows_required'; end if;
 if coalesce(p_input_binding_sha256,'')!~'^[0-9a-f]{64}$' then raise exception 'ocr_vision_v6_input_binding_invalid'; end if;
 select model into v_existing_model from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind=p_pass_kind limit 1;
 if v_existing_model is not null and v_existing_model<>p_model then raise exception 'ocr_vision_v6_model_changed_within_pass'; end if;
 if exists(select 1 from public.ocr_verification_vision_chunks_v4 where job_id=j.id and pass_kind<>p_pass_kind and model=p_model) then raise exception 'ocr_vision_v6_independent_model_required'; end if;
 if exists(select 1 from public.ocr_verification_vision_chunks_v4 where provider_response_id=p_provider_response_id or prompt_sha256=p_prompt_sha256) then raise exception 'ocr_vision_v6_independent_receipt_required'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text) group by article_id having count(*)>1) then raise exception 'ocr_vision_v6_duplicate_article_in_chunk'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text) where not exists(select 1 from public.formal_source_grounded_articles_v6 g where g.partition_job_id=j.partition_job_id and g.article_id=x.article_id)) then raise exception 'ocr_vision_v6_unknown_article'; end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text) where exists(select 1 from public.ocr_verification_transcriptions_v2 t where t.job_id=j.id and t.pass_kind=p_pass_kind and t.article_id=x.article_id)) then raise exception 'ocr_vision_v6_article_already_transcribed'; end if;
 select count(*)::integer,encode(extensions.digest(convert_to(string_agg(x.article_id::text,'|' order by x.article_id::text),'UTF8'),'sha256'),'hex'),
        encode(extensions.digest(convert_to(string_agg(x.article_id::text||':'||c.crop_spec_sha256||':'||c.crop_image_sha256||':'||c.source_mode||':'||c.source_image_sha256,'|' order by x.article_id::text),'UTF8'),'sha256'),'hex')
 into v_count,v_fp,v_binding
 from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text)
 join public.ocr_verification_crop_ocr_v4 c on c.job_id=j.id and c.article_id=x.article_id;
 if v_count<>jsonb_array_length(p_rows) then raise exception 'ocr_vision_v6_chunk_count_or_crop_binding_mismatch'; end if;
 if v_binding is distinct from p_input_binding_sha256 then raise exception 'ocr_vision_v6_input_binding_mismatch'; end if;
 insert into public.ocr_verification_vision_chunks_v4(job_id,pass_kind,chunk_index,model,provider_response_id,prompt_sha256,response_sha256,article_set_fingerprint,article_count,input_binding_sha256)
 values(j.id,p_pass_kind,p_chunk_index,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256,v_fp,v_count,v_binding)
 returning id into v_chunk_id;
 for r in select value from jsonb_array_elements(p_rows) loop
   if coalesce(btrim(r->>'transcription'),'')='' then raise exception 'ocr_vision_v6_empty_transcription'; end if;
   if coalesce((r->>'confidence')::numeric,0)<0.85 then raise exception 'ocr_vision_v6_low_confidence'; end if;
   if coalesce(r->>'proper_noun_status','') not in ('passed','not_applicable','failed') then raise exception 'ocr_vision_v6_bad_proper_noun_status'; end if;
   insert into public.ocr_verification_transcriptions_v2(job_id,pass_kind,article_id,transcription,transcription_sha256,confidence,proper_noun_status,visual_proper_nouns,reason,vision_chunk_id)
   values(j.id,p_pass_kind,(r->>'article_id')::uuid,r->>'transcription',encode(extensions.digest(convert_to(r->>'transcription','UTF8'),'sha256'),'hex'),(r->>'confidence')::numeric,r->>'proper_noun_status',coalesce(array(select jsonb_array_elements_text(coalesce(r->'visual_proper_nouns','[]'::jsonb))),'{}'::text[]),left(coalesce(r->>'reason',''),1000),v_chunk_id);
 end loop;
 return jsonb_build_object('status','stored','chunk_id',v_chunk_id,'chunk_rows',v_count,'pass_kind',p_pass_kind,'input_binding_sha256',v_binding);
end
$function$;

create or replace function public.validate_article_ocr_verification_consensus_v6()
returns trigger
language plpgsql
set search_path='pg_catalog','public','extensions'
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype; v_crop public.ocr_verification_crop_ocr_v4%rowtype; v_t public.ocr_verification_transcriptions_v2%rowtype; v_chunk public.ocr_verification_vision_chunks_v4%rowtype; v_binding text;
begin
 if new.verification_version<>'article_ocr_verification_v5_crop_ocr_plus_independent_vision' or new.quality_status<>'passed' then return new; end if;
 select * into j from public.ocr_verification_page_jobs_v2 where partition_job_id=new.partition_job_id;
 if not found or j.status not in ('running','completed') then raise exception 'ocr_verification_v6_page_job_missing'; end if;
 select * into v_crop from public.ocr_verification_crop_ocr_v4 where job_id=j.id and article_id=new.article_id;
 if not found or new.canonical_text<>v_crop.crop_ocr_text or new.canonical_text_sha256<>v_crop.crop_ocr_text_sha256 then raise exception 'ocr_verification_v6_canonical_not_crop_ocr'; end if;
 select * into v_t from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind='verifier' and article_id=new.article_id;
 if not found or v_t.vision_chunk_id is null then raise exception 'ocr_verification_v6_article_verifier_missing'; end if;
 select * into v_chunk from public.ocr_verification_vision_chunks_v4 where id=v_t.vision_chunk_id;
 if not found or v_chunk.job_id<>j.id or v_chunk.pass_kind<>'verifier' then raise exception 'ocr_verification_v6_article_chunk_invalid'; end if;
 select encode(extensions.digest(convert_to(string_agg(t.article_id::text||':'||c.crop_spec_sha256||':'||c.crop_image_sha256||':'||c.source_mode||':'||c.source_image_sha256,'|' order by t.article_id::text),'UTF8'),'sha256'),'hex') into v_binding
 from public.ocr_verification_transcriptions_v2 t join public.ocr_verification_crop_ocr_v4 c on c.job_id=t.job_id and c.article_id=t.article_id where t.vision_chunk_id=v_chunk.id;
 if v_binding is distinct from v_chunk.input_binding_sha256 then raise exception 'ocr_verification_v6_article_chunk_input_binding_mismatch'; end if;
 if new.independent_model<>v_chunk.model or new.independent_response_id<>v_chunk.provider_response_id or new.independent_prompt_sha256<>v_chunk.prompt_sha256 or new.independent_response_sha256<>v_chunk.response_sha256 then raise exception 'ocr_verification_v6_article_receipt_mismatch'; end if;
 return new;
end
$function$;

drop trigger if exists validate_article_ocr_verification_consensus_v2 on public.article_ocr_verifications_v1;
drop trigger if exists validate_article_ocr_verification_consensus_v5 on public.article_ocr_verifications_v1;
drop trigger if exists validate_article_ocr_verification_consensus_v6 on public.article_ocr_verifications_v1;
create trigger validate_article_ocr_verification_consensus_v6 before insert or update on public.article_ocr_verifications_v1 for each row execute function public.validate_article_ocr_verification_consensus_v6();

revoke all on function public.replace_ocr_crop_results_v6(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.replace_ocr_crop_results_v6(uuid,uuid,jsonb) to service_role;
revoke all on function public.append_ocr_verification_vision_chunk_v6(uuid,uuid,text,integer,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.append_ocr_verification_vision_chunk_v6(uuid,uuid,text,integer,text,text,text,text,text,jsonb) to service_role;
revoke execute on function public.replace_ocr_crop_results_v4(uuid,uuid,jsonb) from service_role;
revoke execute on function public.append_ocr_verification_vision_chunk_v4(uuid,uuid,text,integer,text,text,text,text,jsonb) from service_role;

commit;
begin;

create or replace function public.append_ocr_verification_vision_chunk_v7(p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_chunk_index integer,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_input_binding_sha256 text,p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public'
as $function$
declare
  v_rows integer;
  v_chars integer;
begin
  if jsonb_typeof(p_rows)<>'array' then raise exception 'ocr_vision_v7_rows_required'; end if;
  v_rows:=jsonb_array_length(p_rows);
  if v_rows<1 or v_rows>4 then raise exception 'ocr_vision_v7_chunk_size_exceeds_exact_transcription_limit'; end if;
  select coalesce(sum(char_length(c.crop_ocr_text)),0)::integer into v_chars
  from jsonb_to_recordset(p_rows) x(article_id uuid,transcription text,confidence numeric,proper_noun_status text,visual_proper_nouns text[],reason text)
  join public.ocr_verification_crop_ocr_v4 c on c.job_id=p_job_id and c.article_id=x.article_id;
  if v_chars<=0 or v_chars>7000 then raise exception 'ocr_vision_v7_chunk_text_budget_exceeded'; end if;
  return public.append_ocr_verification_vision_chunk_v6(p_job_id,p_lease_token,p_pass_kind,p_chunk_index,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256,p_input_binding_sha256,p_rows);
end
$function$;

revoke all on function public.append_ocr_verification_vision_chunk_v7(uuid,uuid,text,integer,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.append_ocr_verification_vision_chunk_v7(uuid,uuid,text,integer,text,text,text,text,text,jsonb) to service_role;
revoke execute on function public.append_ocr_verification_vision_chunk_v6(uuid,uuid,text,integer,text,text,text,text,text,jsonb) from service_role;

commit;
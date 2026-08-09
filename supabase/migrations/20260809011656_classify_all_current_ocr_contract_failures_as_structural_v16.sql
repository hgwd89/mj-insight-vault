begin;

create or replace function public.fail_ocr_verification_page_job_v2(p_job_id uuid, p_lease_token uuid, p_error text, p_retryable boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  v_next text;
  v_failures integer;
  v_structural boolean;
  v_message text:=coalesce(p_error,'');
begin
  select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'ocr_verification_v8_lease_invalid'; end if;
  v_structural:=v_message ~* '(ocr_(crop|vision|verification|source_provenance|source_binary)_v[0-9]+_|row_count|unknown or duplicate article|unknown_article|empty_transcription|low_confidence|article_set|not bijective|independent_pass|consensus|numeric_mismatch|proper_noun|crop image fingerprint|source binding|source image path or dimensions are missing|image dimension mismatch)';
  v_failures:=j.failure_count+1;
  v_next:=case when v_structural then 'needs_review' when p_retryable and v_failures<4 then 'queued' else 'failed' end;
  update public.ocr_verification_page_jobs_v2
     set status=v_next,
         failure_count=v_failures,
         lease_token=null,
         lease_expires_at=null,
         error_message=left(v_message,3000),
         updated_at=now(),
         finished_at=case when v_next='failed' then now() else null end
   where id=j.id;
  return jsonb_build_object('status',v_next,'failure_count',v_failures,'structural',v_structural,'retry_scheduled',v_next='queued');
end
$function$;

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='fail_ocr_verification_page_job_v2'
    and pg_get_function_identity_arguments(p.oid)='p_job_id uuid, p_lease_token uuid, p_error text, p_retryable boolean'
  limit 1;
  if position('ocr_(crop|vision|verification|source_provenance|source_binary)_v[0-9]+_' in coalesce(v_def,''))=0 then
    raise exception 'current_ocr_structural_failure_classifier_not_installed';
  end if;
end
$$;

commit;
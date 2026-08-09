begin;
create or replace function public.normalize_chat_job_verified_pipeline_v23()
returns trigger
language plpgsql
set search_path='pg_catalog','public'
as $function$
begin
  if new.status in ('queued','running') and coalesce(new.request_json->>'pipeline_version','') in ('','report_pipeline_v3','verified_report_pipeline_v15') then
    new.request_json:=coalesce(new.request_json,'{}'::jsonb) || jsonb_build_object(
      'pipeline_version','verified_report_pipeline_v15',
      'formal_gate_version','verified_theme_report_v15_query_bound',
      'source_truth','verified_crop_ocr',
      'full_corpus_required',true
    );
  end if;
  return new;
end
$function$;

drop trigger if exists trg_normalize_chat_job_verified_pipeline_v23 on public.chat_jobs;
create trigger trg_normalize_chat_job_verified_pipeline_v23
before insert or update of request_json,status on public.chat_jobs
for each row execute function public.normalize_chat_job_verified_pipeline_v23();
revoke all on function public.normalize_chat_job_verified_pipeline_v23() from public,anon,authenticated;
commit;
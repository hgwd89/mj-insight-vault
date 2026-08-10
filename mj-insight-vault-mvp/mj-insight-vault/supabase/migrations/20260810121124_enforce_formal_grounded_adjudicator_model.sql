-- Formal recovered inventory must never accept the weak Grounded V6/Edge
-- adjudicator fallback. Only GPT-5.6 Sol may write the formal third-pass
-- receipt or its raw visual-region evidence.

create or replace function public.enforce_formal_grounded_adjudicator_model_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $function$
begin
  if new.pass_kind='adjudicator'
     and new.model<>'gpt-5.6-sol'
     and exists (
       select 1
       from public.source_page_article_inventory_jobs_v1 j
       where j.id=new.job_id
         and j.inventory_version='page_article_inventory_v4_recovered_ocr'
     ) then
    raise exception 'formal_grounded_adjudicator_model_not_allowed: %', new.model
      using errcode='23514';
  end if;
  return new;
end
$function$;

drop trigger if exists enforce_formal_grounded_adjudicator_pass_model_v1
  on public.source_page_article_inventory_pass_runs_v1;
create trigger enforce_formal_grounded_adjudicator_pass_model_v1
before insert or update of job_id,pass_kind,model
on public.source_page_article_inventory_pass_runs_v1
for each row execute function public.enforce_formal_grounded_adjudicator_model_v1();

drop trigger if exists enforce_formal_grounded_adjudicator_evidence_model_v1
  on public.source_page_inventory_visual_region_evidence_v6;
create trigger enforce_formal_grounded_adjudicator_evidence_model_v1
before insert or update of job_id,pass_kind,model
on public.source_page_inventory_visual_region_evidence_v6
for each row execute function public.enforce_formal_grounded_adjudicator_model_v1();

revoke all on function public.enforce_formal_grounded_adjudicator_model_v1()
  from public,anon,authenticated;

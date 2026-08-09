create or replace function public.enforce_semantic_review_v2()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  payload jsonb := coalesce(new.answer_json, '{}'::jsonb);
  generation_path text := coalesce(payload->>'generation_path','');
  semantic_status text := coalesce(payload#>>'{semantic_review,status}','');
  semantic_version text := coalesce(payload#>>'{semantic_review,version}','');
begin
  if generation_path = 'full_corpus_hierarchical_theme_evidence_writer_v2'
     and (semantic_status <> 'passed' or semantic_version <> 'semantic_report_critic_v1') then
    raise exception using
      errcode = '23514',
      message = 'semantic_review_required',
      detail = 'Hierarchical writer v2 reports require a passed semantic_report_critic_v1 review.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_semantic_review_v2 on public.chat_reports;
create trigger trg_enforce_semantic_review_v2
before insert or update of answer_json on public.chat_reports
for each row execute function public.enforce_semantic_review_v2();
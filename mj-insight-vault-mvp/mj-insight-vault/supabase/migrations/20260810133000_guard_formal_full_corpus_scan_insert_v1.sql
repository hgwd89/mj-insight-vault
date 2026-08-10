begin;

create or replace function public.guard_formal_full_corpus_scan_insert_v1()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $function$
declare
  v_gate_count integer;
  v_article_count integer;
  v_article_ids_json text;
  v_prompt_version text;
  v_canonical text;
  v_expected_fingerprint text;
  v_expected_batches integer;
begin
  if new.scope_type <> 'all' then
    return new;
  end if;

  select current_article_count
    into v_gate_count
    from public.formal_corpus_freeze_gate_v2
   where freeze_gate_v2='passed'
   limit 1;
  if v_gate_count is null then
    raise exception 'formal_full_corpus_insert_freeze_not_passed';
  end if;

  select count(*)::integer,
         string_agg(to_json(id::text)::text,',' order by id::text)
    into v_article_count,v_article_ids_json
    from public.formal_corpus_articles_v1;

  if v_article_count <> v_gate_count then
    raise exception 'formal_full_corpus_insert_gate_count_mismatch: formal %, gate %',v_article_count,v_gate_count;
  end if;
  if coalesce(new.active_article_count,-1) <> v_article_count then
    raise exception 'formal_full_corpus_insert_active_count_mismatch: new %, formal %',new.active_article_count,v_article_count;
  end if;
  if coalesce(new.ocr_ready_article_count,-1) <> v_article_count then
    raise exception 'formal_full_corpus_insert_ocr_count_mismatch: new %, formal %',new.ocr_ready_article_count,v_article_count;
  end if;
  if coalesce(new.batch_size,0) < 1 then
    raise exception 'formal_full_corpus_insert_bad_batch_size';
  end if;

  v_prompt_version:=coalesce(nullif(new.coverage_json->>'prompt_version',''),'full_corpus_batch_v2');
  v_expected_batches:=ceil(v_article_count::numeric/new.batch_size)::integer;
  if coalesce(new.total_batches,-1) <> v_expected_batches then
    raise exception 'formal_full_corpus_insert_batch_count_mismatch: new %, expected %',new.total_batches,v_expected_batches;
  end if;

  v_canonical:=
    '{"scope_type":"all","scope_query":"","model":'||to_json(coalesce(nullif(btrim(new.model),''),'gpt-4o-mini'))::text||
    ',"batch_size":'||new.batch_size::text||
    ',"prompt_version":'||to_json(v_prompt_version)::text||
    ',"article_ids":['||coalesce(v_article_ids_json,'')||']}';
  v_expected_fingerprint:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');

  if coalesce(new.corpus_fingerprint,'') <> v_expected_fingerprint then
    raise exception 'formal_full_corpus_insert_fingerprint_mismatch';
  end if;

  return new;
end
$function$;

revoke all on function public.guard_formal_full_corpus_scan_insert_v1() from public,anon,authenticated;

-- Stale all-scope runs are not reusable evidence. Retire them before installing
-- the insert guard so legacy application code fails closed instead of finding a
-- queued run whose article set no longer matches the formal corpus.
update public.full_corpus_scan_runs r
   set status='failed',
       error_message=concat(
         'retired by formal corpus guard: run active_article_count=',r.active_article_count,
         ', current formal corpus=',g.current_article_count
       ),
       updated_at=now(),
       finished_at=coalesce(r.finished_at,now())
  from public.formal_corpus_freeze_gate_v2 g
 where g.freeze_gate_v2='passed'
   and r.scope_type='all'
   and r.status in ('queued','running')
   and (
     r.active_article_count is distinct from g.current_article_count
     or r.ocr_ready_article_count is distinct from g.current_article_count
   );

drop trigger if exists trg_guard_formal_full_corpus_scan_insert_v1 on public.full_corpus_scan_runs;
create trigger trg_guard_formal_full_corpus_scan_insert_v1
before insert on public.full_corpus_scan_runs
for each row execute function public.guard_formal_full_corpus_scan_insert_v1();

commit;

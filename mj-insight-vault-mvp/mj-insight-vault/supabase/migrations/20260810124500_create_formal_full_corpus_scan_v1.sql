begin;

create or replace function public.create_formal_full_corpus_scan_v1(
  p_model text default 'gpt-4o-mini',
  p_batch_size integer default 50,
  p_prompt_version text default 'full_corpus_batch_v2'
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $function$
declare
  v_model text:=coalesce(nullif(btrim(p_model),''),'gpt-4o-mini');
  v_prompt_version text:=coalesce(nullif(btrim(p_prompt_version),''),'full_corpus_batch_v2');
  v_batch_size integer:=greatest(5,least(50,coalesce(p_batch_size,50)));
  v_article_count integer;
  v_gate_count integer;
  v_total_batches integer;
  v_article_ids_json text;
  v_canonical text;
  v_fingerprint text;
  v_run_id uuid;
  v_inserted_batches integer;
  v_inserted_articles integer;
begin
  select current_article_count
    into v_gate_count
    from public.formal_corpus_freeze_gate_v2
   where freeze_gate_v2='passed'
   limit 1;
  if v_gate_count is null then
    raise exception 'formal_full_corpus_scan_freeze_not_passed';
  end if;

  select count(*)::integer,
         string_agg(to_json(id::text)::text,',' order by id::text)
    into v_article_count,v_article_ids_json
    from public.formal_corpus_articles_v1;

  if v_article_count<=0 then
    raise exception 'formal_full_corpus_scan_empty';
  end if;
  if v_article_count<>v_gate_count then
    raise exception 'formal_full_corpus_scan_gate_count_mismatch: formal %, gate %',v_article_count,v_gate_count;
  end if;
  if exists(select 1 from public.formal_corpus_articles_v1 where coalesce(btrim(ocr_text),'')='') then
    raise exception 'formal_full_corpus_scan_missing_ocr';
  end if;

  v_total_batches:=ceil(v_article_count::numeric/v_batch_size)::integer;
  v_canonical:=
    '{"scope_type":"all","scope_query":"","model":'||to_json(v_model)::text||
    ',"batch_size":'||v_batch_size::text||
    ',"prompt_version":'||to_json(v_prompt_version)::text||
    ',"article_ids":['||coalesce(v_article_ids_json,'')||']}';
  v_fingerprint:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');

  select id into v_run_id
    from public.full_corpus_scan_runs
   where scope_type='all'
     and scope_query is null
     and corpus_fingerprint=v_fingerprint
     and status in ('queued','running','completed')
   order by created_at desc
   limit 1;

  if v_run_id is not null then
    return jsonb_build_object(
      'run_id',v_run_id,
      'created',false,
      'active_article_count',v_article_count,
      'ocr_ready_article_count',v_article_count,
      'total_batches',v_total_batches,
      'corpus_fingerprint',v_fingerprint,
      'prompt_version',v_prompt_version
    );
  end if;

  insert into public.full_corpus_scan_runs(
    scope_type,scope_query,status,model,batch_size,
    active_article_count,ocr_ready_article_count,total_batches,
    completed_batches,failed_batches,needs_review_batches,analyzed_article_count,
    coverage_json,corpus_fingerprint,error_message
  ) values(
    'all',null,'queued',v_model,v_batch_size,
    v_article_count,v_article_count,v_total_batches,
    0,0,0,0,
    jsonb_build_object(
      'active_article_count',v_article_count,
      'ocr_ready_article_count',v_article_count,
      'missing_ocr_count',0,
      'batch_size',v_batch_size,
      'total_batches',v_total_batches,
      'prompt_version',v_prompt_version,
      'corpus_fingerprint',v_fingerprint,
      'full_corpus_gate','pending'
    ),
    v_fingerprint,
    null
  ) returning id into v_run_id;

  with ordered as (
    select id,
           row_number() over(order by created_at desc,id) as rn
      from public.formal_corpus_articles_v1
  )
  insert into public.full_corpus_scan_batches(
    run_id,batch_index,article_ids,article_count,status,model,prompt_version,
    attempt_count,next_retry_at,last_error_class
  )
  select v_run_id,
         ((rn-1)/v_batch_size)::integer+1,
         array_agg(id order by rn),
         count(*)::integer,
         'queued',v_model,v_prompt_version,0,null,null
    from ordered
   group by ((rn-1)/v_batch_size)::integer+1
   order by ((rn-1)/v_batch_size)::integer+1;

  select count(*)::integer,coalesce(sum(article_count),0)::integer
    into v_inserted_batches,v_inserted_articles
    from public.full_corpus_scan_batches
   where run_id=v_run_id;

  if v_inserted_batches<>v_total_batches or v_inserted_articles<>v_article_count then
    raise exception 'formal_full_corpus_scan_batch_coverage_mismatch: batches %/%, articles %/%',
      v_inserted_batches,v_total_batches,v_inserted_articles,v_article_count;
  end if;

  return jsonb_build_object(
    'run_id',v_run_id,
    'created',true,
    'active_article_count',v_article_count,
    'ocr_ready_article_count',v_article_count,
    'total_batches',v_total_batches,
    'corpus_fingerprint',v_fingerprint,
    'prompt_version',v_prompt_version
  );
end
$function$;

revoke all on function public.create_formal_full_corpus_scan_v1(text,integer,text) from public,anon,authenticated;
grant execute on function public.create_formal_full_corpus_scan_v1(text,integer,text) to service_role;

commit;

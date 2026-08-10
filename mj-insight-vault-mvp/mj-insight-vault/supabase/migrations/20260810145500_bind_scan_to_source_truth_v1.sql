begin;

-- Seal any current, untouched queued all-scope run to the already-passed freeze
-- proof. This does not reinterpret analysis output: only runs with zero completed
-- batches and zero analyzed articles are eligible.
with current_proof as (
  select g.current_article_count,
         g.current_article_set_fingerprint,
         g.current_source_truth_fingerprint,
         g.freeze_receipt_id,
         string_agg(to_json(f.id::text)::text,',' order by f.id::text) as article_ids_json
    from public.formal_corpus_freeze_gate_v2 g
    join public.formal_corpus_articles_v1 f on true
   where g.freeze_gate_v2='passed'
   group by g.current_article_count,g.current_article_set_fingerprint,g.current_source_truth_fingerprint,g.freeze_receipt_id
)
update public.full_corpus_scan_runs r
   set source_truth_fingerprint=p.current_source_truth_fingerprint,
       analysis_contract_version='formal_full_corpus_scan_v3_source_truth',
       coverage_json=r.coverage_json||jsonb_build_object(
         'article_set_fingerprint',p.current_article_set_fingerprint,
         'source_truth_fingerprint',p.current_source_truth_fingerprint,
         'freeze_receipt_id',p.freeze_receipt_id::text,
         'analysis_contract_version','formal_full_corpus_scan_v3_source_truth'
       ),
       updated_at=now()
  from current_proof p
 where r.scope_type='all'
   and r.status='queued'
   and r.completed_batches=0
   and r.analyzed_article_count=0
   and r.active_article_count=p.current_article_count
   and r.ocr_ready_article_count=p.current_article_count
   and r.corpus_fingerprint=encode(
     digest(
       convert_to(
         '{"scope_type":"all","scope_query":"","model":'||to_json(r.model)::text||
         ',"batch_size":'||r.batch_size::text||
         ',"prompt_version":'||to_json(coalesce(nullif(r.coverage_json->>'prompt_version',''),'full_corpus_batch_v2'))::text||
         ',"article_ids":['||coalesce(p.article_ids_json,'')||']}',
         'UTF8'
       ),
       'sha256'
     ),
     'hex'
   );

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
  v_article_set_fingerprint text;
  v_source_truth_fingerprint text;
  v_freeze_receipt_id uuid;
  v_run_id uuid;
  v_inserted_batches integer;
  v_inserted_articles integer;
begin
  select current_article_count,current_article_set_fingerprint,current_source_truth_fingerprint,freeze_receipt_id
    into v_gate_count,v_article_set_fingerprint,v_source_truth_fingerprint,v_freeze_receipt_id
    from public.formal_corpus_freeze_gate_v2
   where freeze_gate_v2='passed'
   limit 1;
  if v_gate_count is null or v_article_set_fingerprint is null or v_source_truth_fingerprint is null or v_freeze_receipt_id is null then
    raise exception 'formal_full_corpus_scan_freeze_not_passed';
  end if;

  select count(*)::integer,string_agg(to_json(id::text)::text,',' order by id::text)
    into v_article_count,v_article_ids_json
    from public.formal_corpus_articles_v1;
  if v_article_count<=0 then raise exception 'formal_full_corpus_scan_empty'; end if;
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
     and source_truth_fingerprint=v_source_truth_fingerprint
     and coalesce(coverage_json->>'article_set_fingerprint','')=v_article_set_fingerprint
     and analysis_contract_version='formal_full_corpus_scan_v3_source_truth'
     and status in ('queued','running','completed')
   order by created_at desc
   limit 1;

  if v_run_id is not null then
    return jsonb_build_object(
      'run_id',v_run_id,'created',false,
      'active_article_count',v_article_count,'ocr_ready_article_count',v_article_count,
      'total_batches',v_total_batches,'corpus_fingerprint',v_fingerprint,
      'article_set_fingerprint',v_article_set_fingerprint,
      'source_truth_fingerprint',v_source_truth_fingerprint,
      'freeze_receipt_id',v_freeze_receipt_id,
      'analysis_contract_version','formal_full_corpus_scan_v3_source_truth',
      'prompt_version',v_prompt_version
    );
  end if;

  insert into public.full_corpus_scan_runs(
    scope_type,scope_query,status,model,batch_size,
    active_article_count,ocr_ready_article_count,total_batches,
    completed_batches,failed_batches,needs_review_batches,analyzed_article_count,
    coverage_json,corpus_fingerprint,source_truth_fingerprint,analysis_contract_version,error_message
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
      'article_set_fingerprint',v_article_set_fingerprint,
      'source_truth_fingerprint',v_source_truth_fingerprint,
      'freeze_receipt_id',v_freeze_receipt_id::text,
      'analysis_contract_version','formal_full_corpus_scan_v3_source_truth',
      'full_corpus_gate','pending'
    ),
    v_fingerprint,v_source_truth_fingerprint,'formal_full_corpus_scan_v3_source_truth',null
  ) returning id into v_run_id;

  with ordered as (
    select id,row_number() over(order by created_at desc,id) as rn
      from public.formal_corpus_articles_v1
  )
  insert into public.full_corpus_scan_batches(
    run_id,batch_index,article_ids,article_count,status,model,prompt_version,
    attempt_count,next_retry_at,last_error_class
  )
  select v_run_id,((rn-1)/v_batch_size)::integer+1,array_agg(id order by rn),count(*)::integer,
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
    'run_id',v_run_id,'created',true,
    'active_article_count',v_article_count,'ocr_ready_article_count',v_article_count,
    'total_batches',v_total_batches,'corpus_fingerprint',v_fingerprint,
    'article_set_fingerprint',v_article_set_fingerprint,
    'source_truth_fingerprint',v_source_truth_fingerprint,
    'freeze_receipt_id',v_freeze_receipt_id,
    'analysis_contract_version','formal_full_corpus_scan_v3_source_truth',
    'prompt_version',v_prompt_version
  );
end
$function$;

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
  v_article_set_fingerprint text;
  v_source_truth_fingerprint text;
  v_freeze_receipt_id uuid;
begin
  if new.scope_type <> 'all' then return new; end if;

  select current_article_count,current_article_set_fingerprint,current_source_truth_fingerprint,freeze_receipt_id
    into v_gate_count,v_article_set_fingerprint,v_source_truth_fingerprint,v_freeze_receipt_id
    from public.formal_corpus_freeze_gate_v2
   where freeze_gate_v2='passed'
   limit 1;
  if v_gate_count is null then raise exception 'formal_full_corpus_insert_freeze_not_passed'; end if;

  select count(*)::integer,string_agg(to_json(id::text)::text,',' order by id::text)
    into v_article_count,v_article_ids_json
    from public.formal_corpus_articles_v1;
  if v_article_count<>v_gate_count then
    raise exception 'formal_full_corpus_insert_gate_count_mismatch: formal %, gate %',v_article_count,v_gate_count;
  end if;
  if coalesce(new.active_article_count,-1)<>v_article_count then
    raise exception 'formal_full_corpus_insert_active_count_mismatch: new %, formal %',new.active_article_count,v_article_count;
  end if;
  if coalesce(new.ocr_ready_article_count,-1)<>v_article_count then
    raise exception 'formal_full_corpus_insert_ocr_count_mismatch: new %, formal %',new.ocr_ready_article_count,v_article_count;
  end if;
  if coalesce(new.batch_size,0)<1 then raise exception 'formal_full_corpus_insert_bad_batch_size'; end if;

  v_prompt_version:=coalesce(nullif(new.coverage_json->>'prompt_version',''),'full_corpus_batch_v2');
  v_expected_batches:=ceil(v_article_count::numeric/new.batch_size)::integer;
  if coalesce(new.total_batches,-1)<>v_expected_batches then
    raise exception 'formal_full_corpus_insert_batch_count_mismatch: new %, expected %',new.total_batches,v_expected_batches;
  end if;

  v_canonical:=
    '{"scope_type":"all","scope_query":"","model":'||to_json(coalesce(nullif(btrim(new.model),''),'gpt-4o-mini'))::text||
    ',"batch_size":'||new.batch_size::text||
    ',"prompt_version":'||to_json(v_prompt_version)::text||
    ',"article_ids":['||coalesce(v_article_ids_json,'')||']}';
  v_expected_fingerprint:=encode(digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');

  if coalesce(new.corpus_fingerprint,'')<>v_expected_fingerprint then
    raise exception 'formal_full_corpus_insert_fingerprint_mismatch';
  end if;
  if coalesce(new.source_truth_fingerprint,'')<>v_source_truth_fingerprint then
    raise exception 'formal_full_corpus_insert_source_truth_mismatch';
  end if;
  if coalesce(new.coverage_json->>'article_set_fingerprint','')<>v_article_set_fingerprint then
    raise exception 'formal_full_corpus_insert_article_set_proof_mismatch';
  end if;
  if coalesce(new.coverage_json->>'freeze_receipt_id','')<>v_freeze_receipt_id::text then
    raise exception 'formal_full_corpus_insert_freeze_receipt_mismatch';
  end if;
  if coalesce(new.analysis_contract_version,'')<>'formal_full_corpus_scan_v3_source_truth' then
    raise exception 'formal_full_corpus_insert_analysis_contract_mismatch';
  end if;

  return new;
end
$function$;

create or replace view public.corpus_scan_gate_view as
with scoped as (
  select r.*,
         case when r.scope_type in ('all','category') then coalesce(cs.current_article_count,0) else r.active_article_count end as current_article_count_calc,
         case when r.scope_type in ('all','category') then cs.article_ids_json else null end as current_article_ids_json,
         cs.current_source_truth_fingerprint,
         coalesce(ba.article_reference_count,0) as batch_article_reference_count_calc,
         coalesce(ba.distinct_article_count,0) as batch_distinct_article_count_calc,
         ba.article_ids_json as batch_article_ids_json,
         cl.category_classification_gate,
         cl.gate_reason as category_gate_reason
    from public.full_corpus_scan_runs r
    left join lateral (
      select count(*)::integer as current_article_count,
             string_agg(to_json(f.id::text)::text,',' order by f.id::text) as article_ids_json,
             encode(
               digest(
                 convert_to(
                   string_agg(
                     f.id::text||':'||f.source_image_id::text||':'||coalesce(a.article_date_normalized::text,'')||':'||coalesce(a.source_ocr_sha256,'')||':'||coalesce(a.analysis_body_clean_sha256,''),
                     '|' order by f.id::text
                   ),
                   'UTF8'
                 ),
                 'sha256'
               ),
               'hex'
             ) as current_source_truth_fingerprint
        from public.formal_corpus_articles_v1 f
        join public.articles a on a.id=f.id
       where r.scope_type='all'
          or (
            r.scope_type='category'
            and exists(
              select 1
                from public.article_category_memberships m
                join public.analysis_categories c on c.id=m.category_id and c.is_active=true
               where m.article_id=f.id
                 and m.category_id=r.scope_query
                 and m.source='article_category_profile_v2'
                 and m.source_analysis_text_sha256=f.analysis_text_sha256
            )
          )
    ) cs on r.scope_type in ('all','category')
    left join lateral (
      select count(x.article_id)::integer as article_reference_count,
             count(distinct x.article_id)::integer as distinct_article_count,
             string_agg(distinct to_json(x.article_id::text)::text,',' order by to_json(x.article_id::text)::text) as article_ids_json
        from public.full_corpus_scan_batches b
        cross join lateral unnest(b.article_ids) as x(article_id)
       where b.run_id=r.id
    ) ba on true
    left join lateral (
      select g.category_classification_gate,g.gate_reason
        from public.category_classification_gate_v2 g
       where r.scope_type='category'
       limit 1
    ) cl on r.scope_type='category'
), fingerprinted as (
  select s.*,
         case when s.scope_type in ('all','category') then
           encode(digest(convert_to(
             '{"scope_type":'||to_json(s.scope_type)::text||
             ',"scope_query":'||to_json(coalesce(s.scope_query,''))::text||
             ',"model":'||to_json(s.model)::text||
             ',"batch_size":'||s.batch_size::text||
             ',"prompt_version":'||to_json(coalesce(nullif(s.coverage_json->>'prompt_version',''),'full_corpus_batch_v2'))::text||
             ',"article_ids":['||coalesce(s.current_article_ids_json,'')||']}',
             'UTF8'),'sha256'),'hex')
           else s.corpus_fingerprint end as current_corpus_fingerprint_calc,
         (s.batch_article_reference_count_calc=s.active_article_count
          and s.batch_distinct_article_count_calc=s.active_article_count
          and coalesce(s.batch_article_ids_json,'')=coalesce(s.current_article_ids_json,'')) as batch_article_set_matches_calc,
         (s.scope_type<>'all' or coalesce(s.source_truth_fingerprint,'')=coalesce(s.current_source_truth_fingerprint,'')) as source_truth_fingerprint_matches_calc
    from scoped s
)
select f.id,f.scope_type,f.scope_query,f.status,f.model,f.active_article_count,
       f.current_article_count_calc as current_article_count,
       f.current_article_count_calc-f.active_article_count as current_article_count_diff,
       f.ocr_ready_article_count,f.total_batches,f.completed_batches,f.failed_batches,f.needs_review_batches,f.analyzed_article_count,
       case
         when f.scope_type='category' and coalesce(f.category_classification_gate,'failed')<>'passed' then 'failed'
         when f.scope_type='category' and not exists(select 1 from public.analysis_categories c where c.id=f.scope_query and c.is_active=true) then 'failed'
         when f.current_article_count_calc<>f.active_article_count then 'failed'
         when coalesce(f.corpus_fingerprint,'')<>coalesce(f.current_corpus_fingerprint_calc,'') then 'failed'
         when not f.source_truth_fingerprint_matches_calc then 'failed'
         when not f.batch_article_set_matches_calc then 'failed'
         when f.status='completed' and f.total_batches>0 and f.completed_batches=f.total_batches and f.failed_batches=0 and f.needs_review_batches=0 and f.analyzed_article_count=f.ocr_ready_article_count and f.ocr_ready_article_count=f.active_article_count then 'passed'
         else 'failed'
       end as full_corpus_gate,
       case
         when f.scope_type='category' and coalesce(f.category_classification_gate,'failed')<>'passed' then 'category_classification_'||coalesce(f.category_gate_reason,'missing')
         when f.scope_type='category' and not exists(select 1 from public.analysis_categories c where c.id=f.scope_query and c.is_active=true) then 'category_inactive_or_missing'
         when f.active_article_count=0 then 'no_articles'
         when f.current_article_count_calc<>f.active_article_count then 'run_stale_article_count_mismatch'
         when coalesce(f.corpus_fingerprint,'')<>coalesce(f.current_corpus_fingerprint_calc,'') then 'run_stale_article_set_mismatch'
         when not f.source_truth_fingerprint_matches_calc then 'run_stale_source_truth_mismatch'
         when f.total_batches=0 then 'no_batches'
         when f.batch_article_reference_count_calc<>f.batch_distinct_article_count_calc then 'duplicate_batch_article_ids'
         when f.batch_distinct_article_count_calc<>f.active_article_count then 'batch_article_count_mismatch'
         when not f.batch_article_set_matches_calc then 'batch_article_set_mismatch'
         when f.ocr_ready_article_count<>f.active_article_count then 'ocr_incomplete'
         when f.completed_batches<>f.total_batches then 'batches_incomplete'
         when f.failed_batches>0 then 'failed_batches_exist'
         when f.needs_review_batches>0 then 'needs_review_batches_exist'
         when f.analyzed_article_count<>f.ocr_ready_article_count then 'analyzed_count_mismatch'
         when f.status<>'completed' then 'run_not_completed'
         else 'passed'
       end as gate_reason,
       f.created_at,f.updated_at,f.finished_at,
       f.current_corpus_fingerprint_calc as current_corpus_fingerprint,
       coalesce(f.corpus_fingerprint,'')=coalesce(f.current_corpus_fingerprint_calc,'') as corpus_fingerprint_matches,
       f.batch_article_reference_count_calc as batch_article_reference_count,
       f.batch_distinct_article_count_calc as batch_distinct_article_count,
       f.batch_article_set_matches_calc as batch_article_set_matches,
       f.current_source_truth_fingerprint,
       f.source_truth_fingerprint_matches_calc as source_truth_fingerprint_matches
  from fingerprinted f;

revoke all on function public.create_formal_full_corpus_scan_v1(text,integer,text) from public,anon,authenticated;
grant execute on function public.create_formal_full_corpus_scan_v1(text,integer,text) to service_role;
revoke all on function public.guard_formal_full_corpus_scan_insert_v1() from public,anon,authenticated;
revoke all on public.corpus_scan_gate_view from public,anon,authenticated;
grant select on public.corpus_scan_gate_view to service_role;

commit;

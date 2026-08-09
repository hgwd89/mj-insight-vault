create or replace function public.split_validation_failed_v2_scan_batches_v1(
  p_run_id uuid,
  p_target_size integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_batch public.full_corpus_scan_batches%rowtype;
  v_target integer := greatest(3, least(coalesce(p_target_size,10),15));
  v_total integer;
  v_start integer;
  v_finish integer;
  v_chunk uuid[];
  v_next_index integer;
  v_added integer := 0;
  v_split integer := 0;
  v_audit jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.full_corpus_scan_runs r
    where r.id=p_run_id
      and coalesce(r.coverage_json->>'prompt_version','')='full_corpus_batch_v2'
      and r.status in ('running','needs_review')
  ) then
    raise exception using errcode='P0002',message='v2_scan_run_not_available';
  end if;

  select coalesce(max(batch_index),-1)+1
  into v_next_index
  from public.full_corpus_scan_batches
  where run_id=p_run_id;

  for v_batch in
    select *
    from public.full_corpus_scan_batches b
    where b.run_id=p_run_id
      and b.status in ('failed','needs_review')
      and b.article_count>v_target
      and coalesce(b.last_error_class,'')='validation'
    order by b.batch_index
    for update skip locked
  loop
    v_total := cardinality(v_batch.article_ids);
    if v_total<>v_batch.article_count or v_total<=v_target then
      continue;
    end if;

    v_audit := v_audit || jsonb_build_array(jsonb_build_object(
      'source_batch_id',v_batch.id,
      'source_batch_index',v_batch.batch_index,
      'source_article_count',v_batch.article_count,
      'source_attempt_count',v_batch.attempt_count,
      'source_error',v_batch.error_message,
      'source_last_error_class',v_batch.last_error_class,
      'split_at',now()
    ));

    update public.full_corpus_scan_batches
    set article_ids=v_batch.article_ids[1:v_target],
        article_count=least(v_target,v_total),
        status='queued',
        summary_json=jsonb_build_object(
          'split_recovery',true,
          'source_batch_id',v_batch.id,
          'source_article_count',v_total,
          'source_error',v_batch.error_message,
          'split_target_size',v_target
        ),
        evidence_article_ids='{}'::text[],
        error_message=null,
        started_at=null,
        finished_at=null,
        attempt_count=0,
        next_retry_at=now(),
        last_error_class=null,
        updated_at=now()
    where id=v_batch.id;

    v_start := v_target+1;
    while v_start<=v_total loop
      v_finish := least(v_start+v_target-1,v_total);
      v_chunk := v_batch.article_ids[v_start:v_finish];

      insert into public.full_corpus_scan_batches(
        run_id,batch_index,article_ids,article_count,status,model,prompt_version,
        summary_json,evidence_article_ids,error_message,started_at,finished_at,
        attempt_count,next_retry_at,last_error_class,created_at,updated_at
      ) values(
        p_run_id,v_next_index,v_chunk,cardinality(v_chunk),'queued',v_batch.model,
        'full_corpus_batch_v2',
        jsonb_build_object(
          'split_recovery',true,
          'source_batch_id',v_batch.id,
          'source_batch_index',v_batch.batch_index,
          'source_article_count',v_total,
          'source_error',v_batch.error_message,
          'split_target_size',v_target,
          'chunk_start',v_start,
          'chunk_end',v_finish
        ),
        '{}'::text[],null,null,null,0,now(),null,now(),now()
      );

      v_next_index := v_next_index+1;
      v_added := v_added+1;
      v_start := v_finish+1;
    end loop;

    v_split := v_split+1;
  end loop;

  update public.full_corpus_scan_runs r
  set total_batches=(select count(*) from public.full_corpus_scan_batches b where b.run_id=r.id),
      completed_batches=(select count(*) from public.full_corpus_scan_batches b where b.run_id=r.id and b.status='completed'),
      failed_batches=(select count(*) from public.full_corpus_scan_batches b where b.run_id=r.id and b.status='failed'),
      needs_review_batches=(select count(*) from public.full_corpus_scan_batches b where b.run_id=r.id and b.status='needs_review'),
      analyzed_article_count=coalesce((select sum(b.article_count) from public.full_corpus_scan_batches b where b.run_id=r.id and b.status='completed'),0),
      status='running',
      error_message=null,
      coverage_json=coalesce(r.coverage_json,'{}'::jsonb) || jsonb_build_object(
        'split_recovery_version','split_validation_failed_v2_scan_batches_v2',
        'split_target_size',v_target,
        'split_batches',coalesce((r.coverage_json->>'split_batches')::integer,0)+v_split,
        'added_batches',coalesce((r.coverage_json->>'added_batches')::integer,0)+v_added,
        'split_audit',coalesce(r.coverage_json->'split_audit','[]'::jsonb) || v_audit
      ),
      updated_at=now(),
      finished_at=null
  where r.id=p_run_id;

  return jsonb_build_object(
    'run_id',p_run_id,
    'split_batches',v_split,
    'added_batches',v_added,
    'target_size',v_target,
    'total_batches',(select count(*) from public.full_corpus_scan_batches where run_id=p_run_id)
  );
end;
$function$;
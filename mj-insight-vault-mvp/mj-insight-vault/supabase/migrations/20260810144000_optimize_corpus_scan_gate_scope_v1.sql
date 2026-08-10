begin;

create or replace view public.corpus_scan_gate_view as
with scoped as (
  select r.*,
         case
           when r.scope_type in ('all','category') then coalesce(cs.current_article_count,0)
           else r.active_article_count
         end as current_article_count_calc,
         case
           when r.scope_type in ('all','category') then cs.article_ids_json
           else null
         end as current_article_ids_json,
         coalesce(ba.article_reference_count,0) as batch_article_reference_count_calc,
         coalesce(ba.distinct_article_count,0) as batch_distinct_article_count_calc,
         ba.article_ids_json as batch_article_ids_json,
         cl.category_classification_gate,
         cl.gate_reason as category_gate_reason
    from public.full_corpus_scan_runs r
    left join lateral (
      select count(*)::integer as current_article_count,
             string_agg(to_json(a.id::text)::text,',' order by a.id::text) as article_ids_json
        from public.formal_corpus_articles_v1 a
       where r.scope_type='all'
          or (
            r.scope_type='category'
            and exists(
              select 1
                from public.article_category_memberships m
                join public.analysis_categories c
                  on c.id=m.category_id
                 and c.is_active=true
               where m.article_id=a.id
                 and m.category_id=r.scope_query
                 and m.source='article_category_profile_v2'
                 and m.source_analysis_text_sha256=a.analysis_text_sha256
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
         case
           when s.scope_type in ('all','category') then
             encode(
               digest(
                 convert_to(
                   '{"scope_type":'||to_json(s.scope_type)::text||
                   ',"scope_query":'||to_json(coalesce(s.scope_query,''))::text||
                   ',"model":'||to_json(s.model)::text||
                   ',"batch_size":'||s.batch_size::text||
                   ',"prompt_version":'||to_json(coalesce(nullif(s.coverage_json->>'prompt_version',''),'full_corpus_batch_v2'))::text||
                   ',"article_ids":['||coalesce(s.current_article_ids_json,'')||']}',
                   'UTF8'
                 ),
                 'sha256'
               ),
               'hex'
             )
           else s.corpus_fingerprint
         end as current_corpus_fingerprint_calc,
         (
           s.batch_article_reference_count_calc=s.active_article_count
           and s.batch_distinct_article_count_calc=s.active_article_count
           and coalesce(s.batch_article_ids_json,'')=coalesce(s.current_article_ids_json,'')
         ) as batch_article_set_matches_calc
    from scoped s
)
select f.id,
       f.scope_type,
       f.scope_query,
       f.status,
       f.model,
       f.active_article_count,
       f.current_article_count_calc as current_article_count,
       f.current_article_count_calc-f.active_article_count as current_article_count_diff,
       f.ocr_ready_article_count,
       f.total_batches,
       f.completed_batches,
       f.failed_batches,
       f.needs_review_batches,
       f.analyzed_article_count,
       case
         when f.scope_type='category' and coalesce(f.category_classification_gate,'failed')<>'passed' then 'failed'
         when f.scope_type='category' and not exists(
           select 1 from public.analysis_categories c where c.id=f.scope_query and c.is_active=true
         ) then 'failed'
         when f.current_article_count_calc<>f.active_article_count then 'failed'
         when coalesce(f.corpus_fingerprint,'')<>coalesce(f.current_corpus_fingerprint_calc,'') then 'failed'
         when not f.batch_article_set_matches_calc then 'failed'
         when f.status='completed'
          and f.total_batches>0
          and f.completed_batches=f.total_batches
          and f.failed_batches=0
          and f.needs_review_batches=0
          and f.analyzed_article_count=f.ocr_ready_article_count
          and f.ocr_ready_article_count=f.active_article_count
         then 'passed'
         else 'failed'
       end as full_corpus_gate,
       case
         when f.scope_type='category' and coalesce(f.category_classification_gate,'failed')<>'passed'
           then 'category_classification_'||coalesce(f.category_gate_reason,'missing')
         when f.scope_type='category' and not exists(
           select 1 from public.analysis_categories c where c.id=f.scope_query and c.is_active=true
         ) then 'category_inactive_or_missing'
         when f.active_article_count=0 then 'no_articles'
         when f.current_article_count_calc<>f.active_article_count then 'run_stale_article_count_mismatch'
         when coalesce(f.corpus_fingerprint,'')<>coalesce(f.current_corpus_fingerprint_calc,'') then 'run_stale_article_set_mismatch'
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
       f.created_at,
       f.updated_at,
       f.finished_at,
       f.current_corpus_fingerprint_calc as current_corpus_fingerprint,
       coalesce(f.corpus_fingerprint,'')=coalesce(f.current_corpus_fingerprint_calc,'') as corpus_fingerprint_matches,
       f.batch_article_reference_count_calc as batch_article_reference_count,
       f.batch_distinct_article_count_calc as batch_distinct_article_count,
       f.batch_article_set_matches_calc as batch_article_set_matches
  from fingerprinted f;

revoke all on public.corpus_scan_gate_view from public,anon,authenticated;
grant select on public.corpus_scan_gate_view to service_role;

commit;

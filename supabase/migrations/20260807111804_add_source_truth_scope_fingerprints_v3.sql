create or replace function public.formal_corpus_scope_proof_v3(
  p_scope_type text default 'all',
  p_scope_query text default ''
)
returns table(article_count bigint,source_truth_fingerprint text)
language sql
stable
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
  with scoped as (
    select distinct v.article_id,v.headline,v.article_date,v.analysis_body_sha256,v.source_raw_ocr_sha256
    from public.formal_article_analysis_text_v2 v
    where p_scope_type='all'
       or (
         p_scope_type='category'
         and coalesce(p_scope_query,'')<>''
         and exists (
           select 1 from public.formal_category_memberships_v3 m
           where m.article_id=v.article_id and m.category_id=p_scope_query
         )
       )
  ), canonical as (
    select count(*)::bigint n,
           coalesce(string_agg(
             encode(extensions.digest(convert_to(
               jsonb_build_array(article_id::text,coalesce(headline,''),coalesce(article_date,''),analysis_body_sha256,source_raw_ocr_sha256)::text,
               'UTF8'),'sha256'),'hex'),
             '|' order by article_id::text
           ),'') payload
    from scoped
  )
  select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex')
  from canonical
  where p_scope_type in ('all','category');
$function$;

create or replace function public.formal_source_grounded_scope_proof_v1(
  p_scope_type text default 'all',
  p_scope_query text default ''
)
returns table(article_count bigint,source_grounded_fingerprint text)
language sql
stable
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
  with scoped as (
    select distinct v.article_id,v.headline,v.article_date,v.analysis_body_sha256,
           v.current_source_raw_ocr_sha256,v.source_region_sha256
    from public.formal_source_grounded_articles_v1 v
    where p_scope_type='all'
       or (
         p_scope_type='category'
         and coalesce(p_scope_query,'')<>''
         and exists (
           select 1 from public.formal_category_memberships_v3 m
           where m.article_id=v.article_id and m.category_id=p_scope_query
         )
       )
  ), canonical as (
    select count(*)::bigint n,
           coalesce(string_agg(
             encode(extensions.digest(convert_to(
               jsonb_build_array(article_id::text,coalesce(headline,''),coalesce(article_date,''),analysis_body_sha256,current_source_raw_ocr_sha256,source_region_sha256)::text,
               'UTF8'),'sha256'),'hex'),
             '|' order by article_id::text
           ),'') payload
    from scoped
  )
  select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex')
  from canonical
  where p_scope_type in ('all','category');
$function$;

revoke all on function public.formal_corpus_scope_proof_v3(text,text) from public,anon,authenticated;
revoke all on function public.formal_source_grounded_scope_proof_v1(text,text) from public,anon,authenticated;
grant execute on function public.formal_corpus_scope_proof_v3(text,text) to postgres,service_role;
grant execute on function public.formal_source_grounded_scope_proof_v1(text,text) to postgres,service_role;
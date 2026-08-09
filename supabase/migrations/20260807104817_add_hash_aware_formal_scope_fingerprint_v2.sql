create or replace function public.formal_corpus_scope_proof_v2(
  p_scope_type text default 'all',
  p_scope_query text default ''
)
returns table(article_count bigint, corpus_content_fingerprint text)
language sql
stable
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
  with scoped as (
    select distinct f.id,f.analysis_text_sha256
    from public.formal_corpus_articles_v1 f
    where p_scope_type='all'
       or (
         p_scope_type='category'
         and coalesce(p_scope_query,'')<>''
         and exists (
           select 1
           from public.article_category_memberships m
           where m.article_id=f.id
             and m.category_id=p_scope_query
             and m.source='article_category_profile_v2'
             and m.source_analysis_text_sha256=f.analysis_text_sha256
         )
       )
  ), canonical as (
    select count(*)::bigint n,
           coalesce(string_agg(id::text||':'||analysis_text_sha256,'|' order by id::text),'') payload
    from scoped
  )
  select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex')
  from canonical
  where p_scope_type in ('all','category');
$function$;

revoke all on function public.formal_corpus_scope_proof_v2(text,text) from public,anon,authenticated;
grant execute on function public.formal_corpus_scope_proof_v2(text,text) to postgres,service_role;
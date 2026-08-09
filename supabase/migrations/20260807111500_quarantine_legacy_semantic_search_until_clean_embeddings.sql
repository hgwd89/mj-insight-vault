create or replace function public.match_articles(query_embedding vector, match_count integer default 12)
returns table(article_id uuid,headline text,ocr_text text,similarity double precision)
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
  select a.id,a.headline,a.ocr_text,
         1-(e.embedding_vector <=> query_embedding) similarity
  from public.formal_article_embeddings_v3 e
  join public.formal_corpus_articles_v1 a on a.id=e.article_id
  where e.embedding_vector is not null
  order by e.embedding_vector <=> query_embedding
  limit greatest(1,least(coalesce(match_count,12),300));
$function$;

revoke all on function public.match_articles(vector,integer) from public;
grant execute on function public.match_articles(vector,integer) to anon,authenticated,service_role;
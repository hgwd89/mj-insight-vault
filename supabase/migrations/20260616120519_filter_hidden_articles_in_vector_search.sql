create or replace function public.match_articles(query_embedding vector, match_count integer default 12)
returns table(article_id uuid, headline text, ocr_text text, similarity double precision)
language sql
stable
as $$
  select
    a.id as article_id,
    a.headline,
    a.ocr_text,
    1 - (ae.embedding_vector <=> query_embedding) as similarity
  from public.article_embeddings ae
  join public.articles a on a.id = ae.article_id
  where ae.embedding_vector is not null
    and (a.status is null or a.status not in ('deleted','excluded','rejected'))
  order by ae.embedding_vector <=> query_embedding
  limit match_count;
$$;
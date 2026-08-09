create or replace view public.formal_corpus_duplicate_gate_v1
with (security_invoker=true)
as
with exact_text as (
  select count(*)::integer n
  from (
    select analysis_text_sha256
    from public.formal_corpus_articles_v1
    group by analysis_text_sha256
    having count(*)>1
  ) q
), same_source_index as (
  select count(*)::integer n
  from public.formal_corpus_articles_v1 a
  join public.formal_corpus_articles_v1 b
    on a.id<b.id
   and a.source_image_id=b.source_image_id
   and a.article_index=b.article_index
  join public.article_embeddings e1 on e1.article_id=a.id
  join public.article_embeddings e2 on e2.article_id=b.id
  where 1-(e1.embedding_vector <=> e2.embedding_vector)>=0.985
), near_source_page as (
  select count(*)::integer n
  from public.source_image_near_duplicate_audit_v1 p
  join public.formal_corpus_articles_v1 a
    on a.source_image_id=p.source_image_id_a
   and a.article_date=p.article_date
  join public.formal_corpus_articles_v1 b
    on b.source_image_id=p.source_image_id_b
   and b.article_date=p.article_date
  join public.article_embeddings e1 on e1.article_id=a.id
  join public.article_embeddings e2 on e2.article_id=b.id
  where similarity(a.headline,b.headline)>=0.50
    and 1-(e1.embedding_vector <=> e2.embedding_vector)>=0.95
), cross_source_same_date as (
  select count(*)::integer n
  from public.formal_corpus_articles_v1 a
  join public.formal_corpus_articles_v1 b
    on a.id<b.id
   and a.article_date=b.article_date
   and a.source_image_id<>b.source_image_id
  join public.article_embeddings e1 on e1.article_id=a.id
  join public.article_embeddings e2 on e2.article_id=b.id
  where similarity(a.headline,b.headline)>=0.80
    and 1-(e1.embedding_vector <=> e2.embedding_vector)>=0.98
)
select
  (select n from exact_text) exact_analysis_text_duplicate_groups,
  (select n from same_source_index) same_source_index_semantic_duplicate_pairs,
  (select n from near_source_page) near_source_page_duplicate_pairs,
  (select n from cross_source_same_date) cross_source_same_date_duplicate_pairs,
  case when (select n from exact_text)=0
         and (select n from same_source_index)=0
         and (select n from near_source_page)=0
         and (select n from cross_source_same_date)=0
       then 'passed' else 'failed' end duplicate_gate,
  case when (select n from exact_text)>0 then 'exact_analysis_text_duplicates_exist'
       when (select n from same_source_index)>0 then 'same_source_index_semantic_duplicates_exist'
       when (select n from near_source_page)>0 then 'near_source_page_duplicates_exist'
       when (select n from cross_source_same_date)>0 then 'cross_source_same_date_duplicates_exist'
       else 'passed' end gate_reason;

revoke all on public.formal_corpus_duplicate_gate_v1 from public,anon,authenticated;
grant select on public.formal_corpus_duplicate_gate_v1 to postgres,service_role;
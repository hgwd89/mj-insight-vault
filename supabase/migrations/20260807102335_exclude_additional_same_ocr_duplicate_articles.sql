with recursive edges as (
  select a.id id1,b.id id2
  from public.formal_corpus_articles_v1 a
  join public.formal_corpus_articles_v1 b
    on a.id<b.id
   and a.article_date=b.article_date
   and a.source_ocr_sha256=b.source_ocr_sha256
  join public.article_embeddings e1 on e1.article_id=a.id
  join public.article_embeddings e2 on e2.article_id=b.id
  where length(a.headline)>=8
    and length(b.headline)>=8
    and similarity(a.headline,b.headline)>=0.50
    and 1-(e1.embedding_vector <=> e2.embedding_vector)>=0.95
), nodes as (
  select id1 id from edges union select id2 from edges
), reach(start_id,node_id) as (
  select id,id from nodes
  union
  select r.start_id,case when e.id1=r.node_id then e.id2 else e.id1 end
  from reach r
  join edges e on e.id1=r.node_id or e.id2=r.node_id
), comp as (
  select start_id,min(node_id::text)::uuid cluster_id
  from reach
  group by start_id
), uniq as (
  select distinct cluster_id,start_id article_id
  from comp
), scores as (
  select u.cluster_id,a.id,a.created_at,a.headline,a.ocr_text,a.reconstruction_confidence,
         max(similarity(a.headline,btrim(x.line))) raw_headline_sim,
         similarity(a.ocr_text,s.ocr_text_raw) raw_body_sim
  from uniq u
  join public.articles a on a.id=u.article_id
  join public.source_images s on s.id=a.source_image_id
  cross join lateral regexp_split_to_table(s.ocr_text_raw,E'\n') x(line)
  where length(btrim(x.line))>=4
  group by u.cluster_id,a.id,a.created_at,a.headline,a.ocr_text,a.reconstruction_confidence,s.ocr_text_raw
), ranked as (
  select *,row_number() over(
    partition by cluster_id
    order by raw_headline_sim desc,
             raw_body_sim desc,
             case reconstruction_confidence when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end desc,
             created_at asc,
             id
  ) rn
  from scores
), mapping as (
  select d.id duplicate_id,c.id canonical_id
  from ranked d
  join ranked c on c.cluster_id=d.cluster_id and c.rn=1
  where d.rn>1
)
update public.articles a
set duplicate_of_article_id=m.canonical_id,
    exclusion_reason='high_confidence_duplicate_same_source_ocr_v3',
    updated_at=now()
from mapping m
where a.id=m.duplicate_id
  and a.duplicate_of_article_id is null;
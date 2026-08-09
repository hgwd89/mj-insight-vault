with recursive edges as (
  select distinct least(a.id,b.id) id1,greatest(a.id,b.id) id2
  from public.source_image_near_duplicate_audit_v1 p
  join public.formal_corpus_articles_v1 a on a.source_image_id=p.source_image_id_a and a.article_date=p.article_date
  join public.formal_corpus_articles_v1 b on b.source_image_id=p.source_image_id_b and b.article_date=p.article_date
  join public.article_embeddings e1 on e1.article_id=a.id
  join public.article_embeddings e2 on e2.article_id=b.id
  where similarity(a.headline,b.headline)>=0.50
    and 1-(e1.embedding_vector <=> e2.embedding_vector)>=0.95
), nodes as (
  select id1 id from edges union select id2 from edges
), reach(start_id,node_id) as (
  select id,id from nodes
  union
  select r.start_id,case when e.id1=r.node_id then e.id2 else e.id1 end
  from reach r join edges e on e.id1=r.node_id or e.id2=r.node_id
), comp as (
  select start_id,min(node_id::text)::uuid cluster_id from reach group by start_id
), uniq as (
  select distinct cluster_id,start_id article_id from comp
), scores as (
  select u.cluster_id,a.id,a.created_at,a.headline,a.ocr_text,a.reconstruction_confidence,
         max(similarity(a.headline,btrim(x.line))) raw_headline_sim,
         similarity(a.ocr_text,s.ocr_text_raw) raw_body_sim,
         case
           when a.id='fe4c6e10-5bc7-42bf-a9a4-3bec589d1f1e'::uuid then 100
           when a.id='ad188d85-233e-46cd-8cd3-d13589f6eaf4'::uuid then -100
           when a.id='165c3788-8c6d-4b02-aded-7745747e1be5'::uuid then 100
           when a.id='c03a6316-0d81-4b9e-a0b8-5817a8b55be0'::uuid then -100
           else 0
         end source_truth_override
  from uniq u
  join public.articles a on a.id=u.article_id
  join public.source_images s on s.id=a.source_image_id
  cross join lateral regexp_split_to_table(s.ocr_text_raw,E'\n') x(line)
  where length(btrim(x.line))>=4
  group by u.cluster_id,a.id,a.created_at,a.headline,a.ocr_text,a.reconstruction_confidence,s.ocr_text_raw
), ranked as (
  select *,row_number() over(
    partition by cluster_id
    order by source_truth_override desc,
             raw_headline_sim desc,
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
    exclusion_reason='high_confidence_duplicate_near_source_ocr_v1',
    updated_at=now()
from mapping m
where a.id=m.duplicate_id
  and a.duplicate_of_article_id is null;
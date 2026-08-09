with recursive x as (
  select f.id,f.headline,a.article_date_normalized d,a.analysis_body_clean,f.source_image_id
  from public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id
), edges as (
  select a.id id1,b.id id2
  from x a join x b on a.d=b.d and a.id<b.id
  where similarity(regexp_replace(a.analysis_body_clean,'\s+','','g'),regexp_replace(b.analysis_body_clean,'\s+','','g'))>=0.50
), adj as (
  select id1 src,id2 dst from edges union all select id2,id1 from edges
), nodes as (
  select src node from adj union select dst from adj
), reach(root,node) as (
  select node,node from nodes
  union
  select r.root,a.dst from reach r join adj a on a.src=r.node
), comps as (
  select node,min(root::text)::uuid root from reach group by node
), scored as (
  select c.root,x.id,
         0.55*coalesce(s.max_headline_sim,0)+0.45*coalesce(s.max_body_sim,0) quality_score,
         length(coalesce(x.analysis_body_clean,'')) body_chars
  from comps c join x on x.id=c.node
  left join lateral (
    select max(similarity(public.normalize_article_headline_v1(x.headline),public.normalize_article_headline_v1(b.block_text))) max_headline_sim,
           max(similarity(regexp_replace(x.analysis_body_clean,'\s+','','g'),regexp_replace(b.block_text,'\s+','','g'))) max_body_sim
    from public.source_ocr_blocks_v1 b where b.source_image_id=x.source_image_id
  ) s on true
), ranked as (
  select *,row_number() over(partition by root order by quality_score desc,body_chars desc,id) rn,
         first_value(id) over(partition by root order by quality_score desc,body_chars desc,id) canonical_id
  from scored
), changed as (
  update public.articles a
     set status='excluded',duplicate_of_article_id=r.canonical_id,
         exclusion_reason='duplicate_reviewed_same_date_clean_body_similarity_v1',updated_at=now()
    from ranked r
   where a.id=r.id and r.rn>1
   returning a.id
)
select count(*) from changed;
with x as (
 select f.id,f.headline,a.article_date_normalized d,a.analysis_body_clean,f.source_image_id
 from public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id
), edges as (
 select a.id id1,b.id id2
 from x a join x b on a.d=b.d and a.id<b.id
 cross join lateral (select similarity(public.normalize_article_headline_v1(a.headline),public.normalize_article_headline_v1(b.headline)) hsim, similarity(regexp_replace(a.analysis_body_clean,'\s+','','g'),regexp_replace(b.analysis_body_clean,'\s+','','g')) bsim) s
 where s.hsim>=0.80 or (s.hsim>=0.70 and s.bsim>=0.20) or (s.hsim>=0.60 and s.bsim>=0.30) or (s.hsim>=0.55 and s.bsim>=0.40)
), candidate_articles as (select id1 id from edges union select id2 from edges), scored as (
 select x.id,
        0.55*coalesce(s.max_headline_sim,0)+0.45*coalesce(s.max_body_sim,0) as quality_score,
        length(coalesce(x.analysis_body_clean,'')) body_chars
 from x join candidate_articles c on c.id=x.id
 left join lateral (
   select max(similarity(public.normalize_article_headline_v1(x.headline),public.normalize_article_headline_v1(b.block_text))) max_headline_sim,
          max(similarity(regexp_replace(x.analysis_body_clean,'\s+','','g'),regexp_replace(b.block_text,'\s+','','g'))) max_body_sim
   from public.source_ocr_blocks_v1 b where b.source_image_id=x.source_image_id
 ) s on true
), decisions as (
 select e.id1,e.id2,
        case when (s1.quality_score,s1.body_chars,s1.id::text)>=(s2.quality_score,s2.body_chars,s2.id::text) then e.id1 else e.id2 end canonical_id,
        case when (s1.quality_score,s1.body_chars,s1.id::text)>=(s2.quality_score,s2.body_chars,s2.id::text) then e.id2 else e.id1 end duplicate_id
 from edges e join scored s1 on s1.id=e.id1 join scored s2 on s2.id=e.id2
), changed as (
 update public.articles a set status='excluded',duplicate_of_article_id=d.canonical_id,
   exclusion_reason='duplicate_same_normalized_publication_date_near_headline_clean_body_v1',updated_at=now()
 from decisions d where a.id=d.duplicate_id returning a.id
)
select count(*) from changed;
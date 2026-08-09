with base as (
  select f.id,f.headline,a.article_date_normalized,f.source_image_id,a.analysis_body_clean,
         public.normalize_article_headline_v1(f.headline) as normalized_headline
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
), grouped as (
  select article_date_normalized,normalized_headline
  from base
  where coalesce(normalized_headline,'')<>''
  group by article_date_normalized,normalized_headline
  having count(*)>1
), scored as (
  select b.*,
         coalesce(s.max_headline_sim,0) max_headline_sim,
         coalesce(s.max_body_sim,0) max_body_sim,
         (0.55*coalesce(s.max_headline_sim,0)+0.45*coalesce(s.max_body_sim,0)) as quality_score
  from base b
  join grouped g using(article_date_normalized,normalized_headline)
  left join lateral (
    select max(similarity(public.normalize_article_headline_v1(b.headline),public.normalize_article_headline_v1(ob.block_text))) as max_headline_sim,
           max(similarity(regexp_replace(b.analysis_body_clean,'\s+','','g'),regexp_replace(ob.block_text,'\s+','','g'))) as max_body_sim
    from public.source_ocr_blocks_v1 ob
    where ob.source_image_id=b.source_image_id
  ) s on true
), ranked as (
  select *,row_number() over(partition by article_date_normalized,normalized_headline order by quality_score desc,length(coalesce(analysis_body_clean,'')) desc,id) as rn,
         first_value(id) over(partition by article_date_normalized,normalized_headline order by quality_score desc,length(coalesce(analysis_body_clean,'')) desc,id) as canonical_id
  from scored
), changed as (
  update public.articles a
     set status='excluded',
         duplicate_of_article_id=r.canonical_id,
         exclusion_reason='duplicate_same_normalized_publication_date_and_headline_v1',
         updated_at=now()
    from ranked r
   where a.id=r.id and r.rn>1
   returning a.id
)
select count(*) from changed;
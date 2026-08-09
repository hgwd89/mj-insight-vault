create or replace function public.validate_article_review_v4_row()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_batch record;
  v_region public.formal_source_grounded_articles_v4%rowtype;
  v_relevance text;
begin
  select id,run_id,batch_index,article_ids into v_batch
  from public.full_corpus_scan_batches where id=new.batch_id;
  if not found or v_batch.run_id<>new.run_id or v_batch.batch_index<>new.batch_index or not(new.article_id=any(v_batch.article_ids)) then
    raise exception using errcode='23514',message='article_review_batch_membership_invalid';
  end if;

  select * into v_region
  from public.formal_source_grounded_articles_v4
  where source_region_id=new.source_region_id and article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='article_review_source_region_not_current_v4'; end if;

  if new.source_clean_body_sha256<>v_region.analysis_body_sha256
     or new.source_region_sha256<>v_region.source_region_sha256
     or new.source_image_raw_ocr_sha256<>v_region.current_source_raw_ocr_sha256 then
    raise exception using errcode='23514',message='article_review_source_hash_mismatch_v4';
  end if;

  v_relevance:=public.consumer_relevance_v4(new.subject,new.measurement);
  new.consumer_relevance:=v_relevance;
  return new;
end $$;

create or replace function public.validate_theme_seed_v4_row()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_review public.full_corpus_article_reviews_v4%rowtype;
  v_region public.formal_source_grounded_articles_v4%rowtype;
begin
  select * into v_review from public.full_corpus_article_reviews_v4 where id=new.review_id;
  if not found or v_review.run_id<>new.run_id or v_review.article_id<>new.article_id then
    raise exception using errcode='23514',message='theme_seed_review_membership_invalid';
  end if;
  select * into v_region from public.formal_source_grounded_articles_v4 where article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='theme_seed_source_region_not_current_v4'; end if;
  if new.source_clean_body_sha256<>v_review.source_clean_body_sha256 or new.source_region_sha256<>v_review.source_region_sha256 then
    raise exception using errcode='23514',message='theme_seed_source_hash_mismatch';
  end if;
  if not public.anchor_grounded_unique_v4(v_region.source_region_text,new.source_anchor) then
    raise exception using errcode='23514',message='theme_seed_source_anchor_not_unique_grounded';
  end if;
  return new;
end $$;

create or replace function public.validate_census_relation_v4_row()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_batch public.theme_census_batches_v4%rowtype;
  v_region public.formal_source_grounded_articles_v4%rowtype;
begin
  select * into v_batch from public.theme_census_batches_v4 where id=new.census_batch_id;
  if not found or v_batch.analysis_run_id<>new.analysis_run_id or not(new.article_id=any(v_batch.article_ids)) then
    raise exception using errcode='23514',message='census_relation_batch_membership_invalid';
  end if;

  select * into v_region from public.formal_source_grounded_articles_v4 where article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='census_relation_source_not_current_v4'; end if;
  if new.source_clean_body_sha256<>v_region.analysis_body_sha256 or new.source_region_sha256<>v_region.source_region_sha256 then
    raise exception using errcode='23514',message='census_relation_source_hash_mismatch';
  end if;

  if new.relation='none' then
    if coalesce(btrim(new.clean_body_anchor),'')<>'' or coalesce(btrim(new.source_region_anchor),'')<>'' then
      raise exception using errcode='23514',message='census_none_relation_must_not_have_anchors';
    end if;
  else
    if coalesce(btrim(new.clean_body_anchor),'')<>'' then
      raise exception using errcode='23514',message='census_clean_body_anchor_forbidden_in_source_grounded_v4';
    end if;
    if not public.anchor_grounded_unique_v4(v_region.source_region_text,new.source_region_anchor) then
      raise exception using errcode='23514',message='census_source_region_anchor_not_unique_grounded';
    end if;
  end if;
  return new;
end $$;

create or replace function public.full_corpus_run_integrity_v4(p_run_id uuid)
returns boolean
language sql
stable security definer
set search_path=pg_catalog,public
as $$
with target as (
  select r.* from public.full_corpus_scan_runs r where r.id=p_run_id
), proof as (
  select t.*,
         cp.article_count current_truth_count,cp.source_truth_fingerprint current_truth_fingerprint,
         gp.article_count current_grounded_count,gp.source_grounded_fingerprint current_grounded_fingerprint
  from target t
  cross join lateral public.formal_corpus_scope_proof_v4(t.scope_type,coalesce(t.scope_query,'')) cp
  cross join lateral public.formal_source_grounded_scope_proof_v4(t.scope_type,coalesce(t.scope_query,'')) gp
), expected as (
  select g.article_id,g.analysis_body_sha256,g.source_region_id,g.source_region_text,g.source_region_sha256,g.current_source_raw_ocr_sha256
  from proof p
  join public.formal_source_grounded_articles_v4 g on p.scope_type='all'
    or (p.scope_type='category' and exists(select 1 from public.formal_category_memberships_v4 m where m.article_id=g.article_id and m.category_id=p.scope_query))
), batches as (
  select b.* from public.full_corpus_scan_batches b where b.run_id=p_run_id
), assigned as (
  select b.id batch_id,b.batch_index,u.article_id,u.ordinality::integer article_no
  from batches b cross join lateral unnest(coalesce(b.article_ids,'{}'::uuid[])) with ordinality u(article_id,ordinality)
), reviews as (
  select r.*,e.source_region_text
  from public.full_corpus_article_reviews_v4 r
  join expected e on e.article_id=r.article_id
  where r.run_id=p_run_id
), anchor_checks as (
  select r.id review_id,a.source_kind,a.anchor_slot,
         case when a.source_kind='source_region' then public.anchor_slot_valid_v4(r.source_region_text,a.anchor_text,a.anchor_slot)
              else false end valid
  from reviews r left join public.full_corpus_article_review_anchors_v4 a on a.review_id=r.id
), review_anchor_stats as (
  select r.id review_id,
         length(regexp_replace(r.source_region_text,'\s+',' ','g')) source_len,
         count(*) filter(where a.source_kind='source_region' and a.anchor_slot='start' and a.valid) source_start,
         count(*) filter(where a.source_kind='source_region' and a.anchor_slot='middle' and a.valid) source_middle,
         count(*) filter(where a.source_kind='source_region' and a.anchor_slot='end' and a.valid) source_end,
         count(*) filter(where a.source_kind='clean_body') clean_anchor_count,
         count(*) filter(where a.source_kind is not null and not coalesce(a.valid,false)) invalid_anchors
  from reviews r left join anchor_checks a on a.review_id=r.id
  group by r.id,r.source_region_text
), seeds as (
  select s.* from public.full_corpus_theme_seeds_v4 s where s.run_id=p_run_id
), seed_stats as (
  select r.id review_id,r.no_theme_signal,count(s.*) seed_count
  from reviews r left join seeds s on s.review_id=r.id
  group by r.id,r.no_theme_signal
), seed_grounding as (
  select s.id,
         e.analysis_body_sha256=s.source_clean_body_sha256
         and e.source_region_sha256=s.source_region_sha256
         and public.anchor_grounded_unique_v4(e.source_region_text,s.source_anchor) valid
  from seeds s join expected e on e.article_id=s.article_id
)
select exists(
  select 1 from proof p
  where p.status='completed'
    and p.analysis_contract_version='strict_report_v4_source_census'
    and coalesce(p.coverage_json->>'prompt_version','')='full_corpus_batch_v4_source_grounded_article_reviews'
    and p.source_truth_fingerprint=p.current_truth_fingerprint
    and p.source_grounded_fingerprint=p.current_grounded_fingerprint
    and p.current_truth_count=p.current_grounded_count
    and p.active_article_count=p.current_grounded_count
    and p.ocr_ready_article_count=p.active_article_count
    and p.analyzed_article_count=p.active_article_count
    and p.total_batches>0 and p.completed_batches=p.total_batches and p.failed_batches=0 and coalesce(p.needs_review_batches,0)=0
    and (select count(*) from batches)=p.total_batches
    and not exists(select 1 from batches b where b.status<>'completed' or b.prompt_version<>'full_corpus_batch_v4_source_grounded_article_reviews' or b.article_count<>cardinality(coalesce(b.article_ids,'{}'::uuid[])))
    and (select count(*) from assigned)=p.active_article_count
    and (select count(distinct article_id) from assigned)=p.active_article_count
    and not exists(select 1 from assigned a left join expected e on e.article_id=a.article_id where e.article_id is null)
    and not exists(select 1 from expected e left join assigned a on a.article_id=e.article_id where a.article_id is null)
    and (select count(*) from reviews)=p.active_article_count
    and not exists(
      select 1 from reviews r
      join expected e on e.article_id=r.article_id
      join assigned a on a.article_id=r.article_id
      where r.batch_id<>a.batch_id or r.batch_index<>a.batch_index
         or r.source_clean_body_sha256<>e.analysis_body_sha256
         or r.source_region_id<>e.source_region_id
         or r.source_region_sha256<>e.source_region_sha256
         or r.source_image_raw_ocr_sha256<>e.current_source_raw_ocr_sha256
         or r.consumer_relevance<>public.consumer_relevance_v4(r.subject,r.measurement)
    )
    and not exists(
      select 1 from review_anchor_stats s
      where s.invalid_anchors>0
         or s.clean_anchor_count<>0
         or s.source_start<>1
         or (s.source_len>=800 and s.source_middle<>1)
         or (s.source_len<800 and s.source_middle<>0)
         or (s.source_len>=350 and s.source_end<>1)
         or (s.source_len<350 and s.source_end<>0)
    )
    and not exists(select 1 from seed_stats where (no_theme_signal and seed_count<>0) or (not no_theme_signal and seed_count<1))
    and not exists(select 1 from seed_grounding where not valid)
);
$$;

create or replace function public.validate_theme_analysis_run_v4_row()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_scan public.full_corpus_scan_runs%rowtype;
  v_truth record;
  v_ground record;
  v_seed_count integer;
begin
  select * into v_scan from public.full_corpus_scan_runs where id=new.scan_run_id;
  if not found or not public.full_corpus_run_integrity_v4(new.scan_run_id) then
    raise exception using errcode='23514',message='theme_analysis_requires_valid_v4_scan';
  end if;
  if new.scope_type<>v_scan.scope_type or coalesce(new.scope_query,'')<>coalesce(v_scan.scope_query,'') then
    raise exception using errcode='23514',message='theme_analysis_scope_mismatch';
  end if;
  select * into v_truth from public.formal_corpus_scope_proof_v4(new.scope_type,coalesce(new.scope_query,''));
  select * into v_ground from public.formal_source_grounded_scope_proof_v4(new.scope_type,coalesce(new.scope_query,''));
  select count(*)::integer into v_seed_count from public.full_corpus_theme_seeds_v4 where run_id=new.scan_run_id;
  new.source_truth_fingerprint:=v_truth.source_truth_fingerprint;
  new.source_grounded_fingerprint:=v_ground.source_grounded_fingerprint;
  new.expected_article_count:=v_ground.article_count;
  new.expected_seed_count:=v_seed_count;
  return new;
end $$;

create or replace function public.theme_census_integrity_v4(p_analysis_run_id uuid)
returns boolean
language sql
stable security definer
set search_path=pg_catalog,public
as $$
with ar as (
  select * from public.theme_analysis_runs_v4 where id=p_analysis_run_id
), scan_ok as (
  select a.*,public.full_corpus_run_integrity_v4(a.scan_run_id) scan_valid,
         public.theme_candidate_set_fingerprint_v4(a.id) current_candidate_fingerprint
  from ar a
), reviews as (
  select r.article_id,r.source_clean_body_sha256,r.source_region_sha256
  from scan_ok a join public.full_corpus_article_reviews_v4 r on r.run_id=a.scan_run_id
), candidates as (
  select c.* from public.theme_candidates_v4 c where c.analysis_run_id=p_analysis_run_id
), batches as (
  select b.* from public.theme_census_batches_v4 b where b.analysis_run_id=p_analysis_run_id
), assigned as (
  select b.id batch_id,b.batch_index,u.article_id
  from batches b cross join lateral unnest(b.article_ids) u(article_id)
), relations as (
  select x.*,g.source_region_text,g.source_region_sha256 current_source_region_sha256,g.analysis_body_sha256 current_clean_body_sha256
  from public.theme_census_relations_v4 x
  left join public.formal_source_grounded_articles_v4 g on g.article_id=x.article_id
  where x.analysis_run_id=p_analysis_run_id
), relation_validity as (
  select r.*,
    r.current_clean_body_sha256=r.source_clean_body_sha256
    and r.current_source_region_sha256=r.source_region_sha256
    and (
      (r.relation='none' and coalesce(btrim(r.clean_body_anchor),'')='' and coalesce(btrim(r.source_region_anchor),'')='')
      or
      (r.relation<>'none'
       and coalesce(btrim(r.clean_body_anchor),'')=''
       and public.anchor_grounded_unique_v4(r.source_region_text,r.source_region_anchor))
    ) valid
  from relations r
), seed_counts as (
  select a.id analysis_run_id,
         (select count(*) from public.full_corpus_theme_seeds_v4 s where s.run_id=a.scan_run_id) actual_seed_count,
         (select count(*) from public.theme_seed_mappings_v4 m where m.analysis_run_id=a.id) mapping_count
  from scan_ok a
)
select exists(
  select 1 from scan_ok a cross join seed_counts sc
  where a.scan_valid
    and a.candidate_set_locked_at is not null
    and coalesce(a.candidate_set_fingerprint,'')<>''
    and a.candidate_set_fingerprint=a.current_candidate_fingerprint
    and a.expected_article_count=(select count(*) from reviews)
    and a.expected_seed_count=sc.actual_seed_count
    and sc.mapping_count=sc.actual_seed_count
    and (select count(*) from candidates)>0
    and not exists(select 1 from batches where candidate_set_fingerprint<>a.candidate_set_fingerprint or status<>'completed' or article_count<>cardinality(article_ids))
    and (select count(*) from assigned)=a.expected_article_count
    and (select count(distinct article_id) from assigned)=a.expected_article_count
    and not exists(select 1 from assigned x left join reviews r on r.article_id=x.article_id where r.article_id is null)
    and not exists(select 1 from reviews r left join assigned x on x.article_id=r.article_id where x.article_id is null)
    and (select count(*) from relation_validity)=a.expected_article_count*(select count(*) from candidates)
    and not exists(select 1 from relation_validity where not valid)
    and not exists(select 1 from relation_validity r left join candidates c on c.id=r.candidate_id where c.id is null)
    and not exists(select 1 from relation_validity r left join assigned x on x.batch_id=r.census_batch_id and x.article_id=r.article_id where x.article_id is null)
    and not exists(
      select 1 from reviews r cross join candidates c
      where not exists(select 1 from relation_validity x where x.article_id=r.article_id and x.candidate_id=c.id)
    )
    and not exists(
      select 1 from candidates c
      where (select count(*) from relation_validity r where r.candidate_id=c.id)<>a.expected_article_count
    )
);
$$;
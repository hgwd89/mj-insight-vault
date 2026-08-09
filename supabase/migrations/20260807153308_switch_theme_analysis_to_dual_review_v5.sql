create or replace function public.validate_theme_analysis_run_v4_row()
returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_scan public.full_corpus_scan_runs%rowtype;v_truth record;v_ground record;v_seed_count integer;begin
  select * into v_scan from public.full_corpus_scan_runs where id=new.scan_run_id;
  if not found or not public.full_corpus_run_integrity_v5(new.scan_run_id) then raise exception using errcode='23514',message='theme_analysis_requires_valid_v5_dual_review_scan'; end if;
  if new.scope_type<>v_scan.scope_type or coalesce(new.scope_query,'')<>coalesce(v_scan.scope_query,'') then raise exception using errcode='23514',message='theme_analysis_scope_mismatch'; end if;
  select * into v_truth from public.formal_corpus_scope_proof_v4(new.scope_type,coalesce(new.scope_query,''));select * into v_ground from public.formal_source_grounded_scope_proof_v4(new.scope_type,coalesce(new.scope_query,''));
  select count(*)::integer into v_seed_count from public.full_corpus_theme_seeds_v4 where run_id=new.scan_run_id and seed_version='theme_seed_v5_source_block';
  new.source_truth_fingerprint:=v_truth.source_truth_fingerprint;new.source_grounded_fingerprint:=v_ground.source_grounded_fingerprint;new.expected_article_count:=v_ground.article_count;new.expected_seed_count:=v_seed_count;return new;
end $$;

create or replace function public.theme_census_integrity_v4(p_analysis_run_id uuid)
returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
with ar as (select * from public.theme_analysis_runs_v4 where id=p_analysis_run_id),scan_ok as (
  select a.*,public.full_corpus_run_integrity_v5(a.scan_run_id) scan_valid,public.theme_candidate_set_fingerprint_v4(a.id) current_candidate_fingerprint from ar a
),reviews as (
  select r.article_id,r.source_clean_body_sha256,r.source_region_sha256,r.source_region_id from scan_ok a join public.full_corpus_article_reviews_v4 r on r.run_id=a.scan_run_id and r.review_version='article_review_v5_dual_source_block'
),candidates as (select c.* from public.theme_candidates_v4 c where c.analysis_run_id=p_analysis_run_id),batches as (select b.* from public.theme_census_batches_v4 b where b.analysis_run_id=p_analysis_run_id),assigned as (
  select b.id batch_id,b.batch_index,u.article_id from batches b cross join lateral unnest(b.article_ids) u(article_id)
),relations as (
  select x.*,g.source_region_id current_source_region_id,g.source_region_sha256 current_source_region_sha256,g.analysis_body_sha256 current_clean_body_sha256
  from public.theme_census_relations_v4 x left join public.formal_source_grounded_articles_v4 g on g.article_id=x.article_id where x.analysis_run_id=p_analysis_run_id
),relation_validity as (
  select r.*,r.current_clean_body_sha256=r.source_clean_body_sha256 and r.current_source_region_sha256=r.source_region_sha256 and (
    (r.relation='none' and coalesce(btrim(r.clean_body_anchor),'')='' and coalesce(btrim(r.source_region_anchor),'')='' and r.source_block_index is null and r.source_block_sha256 is null)
    or (r.relation<>'none' and coalesce(btrim(r.clean_body_anchor),'')='' and exists(select 1 from public.unique_source_block_for_anchor_v4(r.article_id,r.current_source_region_id,r.source_region_anchor) b where b.block_index=r.source_block_index and b.source_block_sha256=r.source_block_sha256))
  ) valid from relations r
),seed_counts as (
  select a.id analysis_run_id,(select count(*) from public.full_corpus_theme_seeds_v4 s where s.run_id=a.scan_run_id and s.seed_version='theme_seed_v5_source_block') actual_seed_count,(select count(*) from public.theme_seed_mappings_v4 m where m.analysis_run_id=a.id) mapping_count from scan_ok a
)
select exists(
  select 1 from scan_ok a cross join seed_counts sc
  where a.scan_valid and a.candidate_set_locked_at is not null and coalesce(a.candidate_set_fingerprint,'')<>'' and a.candidate_set_fingerprint=a.current_candidate_fingerprint
    and a.expected_article_count=(select count(*) from reviews) and a.expected_seed_count=sc.actual_seed_count and sc.mapping_count=sc.actual_seed_count and (select count(*) from candidates)>0
    and not exists(select 1 from batches where candidate_set_fingerprint<>a.candidate_set_fingerprint or status<>'completed' or article_count<>cardinality(article_ids))
    and (select count(*) from assigned)=a.expected_article_count and (select count(distinct article_id) from assigned)=a.expected_article_count
    and not exists(select 1 from assigned x left join reviews r on r.article_id=x.article_id where r.article_id is null)
    and not exists(select 1 from reviews r left join assigned x on x.article_id=r.article_id where x.article_id is null)
    and (select count(*) from relation_validity)=a.expected_article_count*(select count(*) from candidates)
    and not exists(select 1 from relation_validity where not valid)
    and not exists(select 1 from relation_validity r left join candidates c on c.id=r.candidate_id where c.id is null)
    and not exists(select 1 from relation_validity r left join assigned x on x.batch_id=r.census_batch_id and x.article_id=r.article_id where x.article_id is null)
    and not exists(select 1 from reviews r cross join candidates c where not exists(select 1 from relation_validity x where x.article_id=r.article_id and x.candidate_id=c.id))
    and not exists(select 1 from candidates c where (select count(*) from relation_validity r where r.candidate_id=c.id)<>a.expected_article_count)
);
$$;
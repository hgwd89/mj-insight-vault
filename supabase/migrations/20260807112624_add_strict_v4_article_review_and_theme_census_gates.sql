create or replace function public.anchor_slot_valid_v4(p_text text,p_anchor text,p_slot text)
returns boolean
language plpgsql
immutable
set search_path to 'pg_catalog','public'
as $function$
declare
  t text:=lower(regexp_replace(coalesce(p_text,''),'\s+',' ','g'));
  a text:=lower(regexp_replace(btrim(coalesce(p_anchor,'')),'\s+',' ','g'));
  p integer;
  n integer;
  occurrences integer;
begin
  if length(a)<8 or length(t)=0 then return false; end if;
  p:=position(a in t);
  if p=0 then return false; end if;
  occurrences:=(length(t)-length(replace(t,a,'')))/greatest(length(a),1);
  if occurrences<>1 then return false; end if;
  n:=length(t);
  if p_slot='start' then return n<350 or p<=ceil(n*0.45);
  elsif p_slot='middle' then return n>=800 and p>=floor(n*0.25) and p<=ceil(n*0.75);
  elsif p_slot='end' then return n>=350 and p>=floor(n*0.55);
  end if;
  return false;
end;
$function$;

create or replace function public.full_corpus_run_integrity_v4(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog','public'
as $function$
with target as (
  select r.* from public.full_corpus_scan_runs r where r.id=p_run_id
), proof as (
  select t.*,
         cp.article_count current_truth_count,cp.source_truth_fingerprint current_truth_fingerprint,
         gp.article_count current_grounded_count,gp.source_grounded_fingerprint current_grounded_fingerprint
  from target t
  cross join lateral public.formal_corpus_scope_proof_v3(t.scope_type,coalesce(t.scope_query,'')) cp
  cross join lateral public.formal_source_grounded_scope_proof_v1(t.scope_type,coalesce(t.scope_query,'')) gp
), expected as (
  select g.article_id,g.analysis_body,g.analysis_body_sha256,g.source_region_id,g.source_region_text,g.source_region_sha256,g.current_source_raw_ocr_sha256
  from proof p
  join public.formal_source_grounded_articles_v1 g on p.scope_type='all'
    or (p.scope_type='category' and exists(select 1 from public.formal_category_memberships_v3 m where m.article_id=g.article_id and m.category_id=p.scope_query))
), batches as (
  select b.* from public.full_corpus_scan_batches b where b.run_id=p_run_id
), assigned as (
  select b.id batch_id,b.batch_index,u.article_id,u.ordinality::integer article_no
  from batches b cross join lateral unnest(coalesce(b.article_ids,'{}'::uuid[])) with ordinality u(article_id,ordinality)
), reviews as (
  select r.*,e.analysis_body,e.source_region_text
  from public.full_corpus_article_reviews_v4 r
  join expected e on e.article_id=r.article_id
  where r.run_id=p_run_id
), anchor_checks as (
  select r.id review_id,a.source_kind,a.anchor_slot,
         case when a.source_kind='clean_body' then public.anchor_slot_valid_v4(r.analysis_body,a.anchor_text,a.anchor_slot)
              when a.source_kind='source_region' then public.anchor_slot_valid_v4(r.source_region_text,a.anchor_text,a.anchor_slot)
              else false end valid
  from reviews r left join public.full_corpus_article_review_anchors_v4 a on a.review_id=r.id
), review_anchor_stats as (
  select r.id review_id,
         length(regexp_replace(r.analysis_body,'\s+',' ','g')) clean_len,
         length(regexp_replace(r.source_region_text,'\s+',' ','g')) source_len,
         count(*) filter(where a.source_kind='clean_body' and a.anchor_slot='start' and a.valid) clean_start,
         count(*) filter(where a.source_kind='clean_body' and a.anchor_slot='middle' and a.valid) clean_middle,
         count(*) filter(where a.source_kind='clean_body' and a.anchor_slot='end' and a.valid) clean_end,
         count(*) filter(where a.source_kind='source_region' and a.anchor_slot='start' and a.valid) source_start,
         count(*) filter(where a.source_kind='source_region' and a.anchor_slot='middle' and a.valid) source_middle,
         count(*) filter(where a.source_kind='source_region' and a.anchor_slot='end' and a.valid) source_end,
         count(*) filter(where not coalesce(a.valid,false)) invalid_anchors
  from reviews r left join anchor_checks a on a.review_id=r.id
  group by r.id,r.analysis_body,r.source_region_text
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
         and position(lower(regexp_replace(btrim(s.source_anchor),'\s+',' ','g')) in lower(regexp_replace(e.source_region_text,'\s+',' ','g')))>0 valid
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
         or s.clean_start<>1
         or (s.clean_len>=800 and s.clean_middle<>1)
         or (s.clean_len<800 and s.clean_middle<>0)
         or (s.clean_len>=350 and s.clean_end<>1)
         or (s.clean_len<350 and s.clean_end<>0)
         or s.source_start<>1
         or (s.source_len>=800 and s.source_middle<>1)
         or (s.source_len<800 and s.source_middle<>0)
         or (s.source_len>=350 and s.source_end<>1)
         or (s.source_len<350 and s.source_end<>0)
    )
    and not exists(select 1 from seed_stats where (no_theme_signal and seed_count<>0) or (not no_theme_signal and seed_count<1))
    and not exists(select 1 from seed_grounding where not valid)
);
$function$;

create or replace function public.validate_theme_analysis_run_v4_row()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
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
  select * into v_truth from public.formal_corpus_scope_proof_v3(new.scope_type,coalesce(new.scope_query,''));
  select * into v_ground from public.formal_source_grounded_scope_proof_v1(new.scope_type,coalesce(new.scope_query,''));
  select count(*)::integer into v_seed_count from public.full_corpus_theme_seeds_v4 where run_id=new.scan_run_id;
  new.source_truth_fingerprint:=v_truth.source_truth_fingerprint;
  new.source_grounded_fingerprint:=v_ground.source_grounded_fingerprint;
  new.expected_article_count:=v_ground.article_count;
  new.expected_seed_count:=v_seed_count;
  return new;
end;
$function$;

create or replace function public.theme_candidate_set_fingerprint_v4(p_analysis_run_id uuid)
returns text
language sql
stable
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
with candidates as (
  select coalesce(string_agg(jsonb_build_array(theme_key,title,definition,inclusion_rule,exclusion_rule,discovery_method)::text,'|' order by theme_key),'') payload
  from public.theme_candidates_v4 where analysis_run_id=p_analysis_run_id
), mappings as (
  select coalesce(string_agg(jsonb_build_array(m.seed_id::text,m.disposition,coalesce(c.theme_key,''),m.reason)::text,'|' order by m.seed_id::text),'') payload
  from public.theme_seed_mappings_v4 m
  left join public.theme_candidates_v4 c on c.id=m.candidate_id
  where m.analysis_run_id=p_analysis_run_id
)
select encode(extensions.digest(convert_to((select payload from candidates)||E'\n--MAP--\n'||(select payload from mappings),'UTF8'),'sha256'),'hex');
$function$;

create or replace function public.lock_theme_candidate_set_v4(p_analysis_run_id uuid)
returns text
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  r public.theme_analysis_runs_v4%rowtype;
  v_seed_count integer;
  v_mapping_count integer;
  v_candidate_count integer;
  v_fingerprint text;
begin
  select * into r from public.theme_analysis_runs_v4 where id=p_analysis_run_id for update;
  if not found then raise exception using errcode='P0002',message='theme_analysis_run_not_found'; end if;
  if r.candidate_set_locked_at is not null then return r.candidate_set_fingerprint; end if;
  if not public.full_corpus_run_integrity_v4(r.scan_run_id) then raise exception using errcode='23514',message='scan_became_invalid_before_candidate_lock'; end if;
  select count(*)::integer into v_seed_count from public.full_corpus_theme_seeds_v4 where run_id=r.scan_run_id;
  select count(*)::integer into v_mapping_count from public.theme_seed_mappings_v4 where analysis_run_id=r.id;
  select count(*)::integer into v_candidate_count from public.theme_candidates_v4 where analysis_run_id=r.id;
  if v_seed_count<>r.expected_seed_count or v_mapping_count<>v_seed_count then raise exception using errcode='23514',message='theme_seed_mapping_incomplete'; end if;
  if v_candidate_count<1 then raise exception using errcode='23514',message='theme_candidate_set_empty'; end if;
  if exists(select 1 from public.theme_candidates_v4 c where c.analysis_run_id=r.id and not exists(select 1 from public.theme_seed_mappings_v4 m where m.analysis_run_id=r.id and m.candidate_id=c.id and m.disposition='mapped')) then
    raise exception using errcode='23514',message='theme_candidate_has_no_mapped_seed';
  end if;
  v_fingerprint:=public.theme_candidate_set_fingerprint_v4(r.id);
  update public.theme_analysis_runs_v4
  set candidate_set_fingerprint=v_fingerprint,candidate_set_locked_at=now(),status='census_queued',updated_at=now()
  where id=r.id;
  return v_fingerprint;
end;
$function$;

drop trigger if exists trg_validate_theme_analysis_run_v4 on public.theme_analysis_runs_v4;
create trigger trg_validate_theme_analysis_run_v4 before insert or update of scan_run_id,scope_type,scope_query on public.theme_analysis_runs_v4 for each row execute function public.validate_theme_analysis_run_v4_row();

revoke all on function public.anchor_slot_valid_v4(text,text,text),public.full_corpus_run_integrity_v4(uuid),public.validate_theme_analysis_run_v4_row(),public.theme_candidate_set_fingerprint_v4(uuid),public.lock_theme_candidate_set_v4(uuid) from public,anon,authenticated;
grant execute on function public.anchor_slot_valid_v4(text,text,text),public.full_corpus_run_integrity_v4(uuid),public.validate_theme_analysis_run_v4_row(),public.theme_candidate_set_fingerprint_v4(uuid),public.lock_theme_candidate_set_v4(uuid) to postgres,service_role;
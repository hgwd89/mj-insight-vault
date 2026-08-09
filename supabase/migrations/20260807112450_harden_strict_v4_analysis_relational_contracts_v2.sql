alter table public.full_corpus_article_reviews_v4
  add constraint article_reviews_v4_run_id_id_unique unique(id,run_id),
  add constraint article_reviews_v4_run_article_unique unique(id,run_id,article_id);

alter table public.full_corpus_theme_seeds_v4
  add constraint theme_seeds_v4_id_run_unique unique(id,run_id),
  add constraint theme_seeds_v4_id_run_article_unique unique(id,run_id,article_id);

alter table public.theme_candidates_v4
  add constraint theme_candidates_v4_id_run_unique unique(id,analysis_run_id);

alter table public.theme_census_batches_v4
  add constraint theme_census_batches_v4_id_run_unique unique(id,analysis_run_id);

alter table public.theme_seed_mappings_v4
  add constraint theme_seed_mapping_candidate_same_run_fk
  foreign key(candidate_id,analysis_run_id)
  references public.theme_candidates_v4(id,analysis_run_id)
  on delete cascade;

alter table public.theme_census_relations_v4
  add constraint theme_census_relation_candidate_same_run_fk
  foreign key(candidate_id,analysis_run_id)
  references public.theme_candidates_v4(id,analysis_run_id)
  on delete cascade,
  add constraint theme_census_relation_batch_same_run_fk
  foreign key(census_batch_id,analysis_run_id)
  references public.theme_census_batches_v4(id,analysis_run_id)
  on delete cascade;

create or replace function public.consumer_relevance_v4(p_subject text,p_measurement text)
returns text
language sql
immutable
as $function$
  select case
    when p_subject='consumer' and p_measurement in ('survey','purchase','usage','consumer_quote','observation') then 'direct'
    when p_subject='mixed' and p_measurement in ('survey','purchase','usage','consumer_quote','observation','sales','market_data') then 'indirect'
    when p_subject in ('consumer','company','market') and p_measurement in ('sales','market_data') then 'indirect'
    when p_subject='unclear' then 'unclear'
    else 'none'
  end;
$function$;

create or replace function public.validate_article_review_v4_row()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_batch record;
  v_region record;
  v_clean record;
  v_relevance text;
begin
  select id,run_id,batch_index,article_ids into v_batch
  from public.full_corpus_scan_batches where id=new.batch_id;
  if not found or v_batch.run_id<>new.run_id or v_batch.batch_index<>new.batch_index or not (new.article_id=any(v_batch.article_ids)) then
    raise exception using errcode='23514',message='article_review_batch_membership_invalid';
  end if;

  select * into v_region from public.formal_source_grounded_articles_v1 where source_region_id=new.source_region_id and article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='article_review_source_region_not_current'; end if;

  select * into v_clean from public.formal_article_analysis_text_v2 where article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='article_review_clean_article_not_current'; end if;

  if new.source_clean_body_sha256<>v_clean.analysis_body_sha256
     or new.source_region_sha256<>v_region.source_region_sha256
     or new.source_image_raw_ocr_sha256<>v_region.current_source_raw_ocr_sha256 then
    raise exception using errcode='23514',message='article_review_source_hash_mismatch';
  end if;

  v_relevance:=public.consumer_relevance_v4(new.subject,new.measurement);
  new.consumer_relevance:=v_relevance;
  return new;
end;
$function$;

create or replace function public.validate_theme_seed_v4_row()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_review public.full_corpus_article_reviews_v4%rowtype;
  v_region public.formal_source_grounded_articles_v1%rowtype;
begin
  select * into v_review from public.full_corpus_article_reviews_v4 where id=new.review_id;
  if not found or v_review.run_id<>new.run_id or v_review.article_id<>new.article_id then
    raise exception using errcode='23514',message='theme_seed_review_membership_invalid';
  end if;
  select * into v_region from public.formal_source_grounded_articles_v1 where article_id=new.article_id;
  if not found then raise exception using errcode='23514',message='theme_seed_source_region_not_current'; end if;
  if new.source_clean_body_sha256<>v_review.source_clean_body_sha256 or new.source_region_sha256<>v_review.source_region_sha256 then
    raise exception using errcode='23514',message='theme_seed_source_hash_mismatch';
  end if;
  if position(lower(regexp_replace(btrim(new.source_anchor),'\s+',' ','g')) in lower(regexp_replace(v_region.source_region_text,'\s+',' ','g')))=0 then
    raise exception using errcode='23514',message='theme_seed_source_anchor_not_grounded';
  end if;
  return new;
end;
$function$;

create or replace function public.prevent_locked_theme_set_mutation_v4()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare v_run_id uuid; v_locked timestamptz;
begin
  if tg_table_name='theme_candidates_v4' then
    v_run_id:=coalesce(new.analysis_run_id,old.analysis_run_id);
  else
    v_run_id:=coalesce(new.analysis_run_id,old.analysis_run_id);
  end if;
  select candidate_set_locked_at into v_locked from public.theme_analysis_runs_v4 where id=v_run_id;
  if v_locked is not null then
    raise exception using errcode='23514',message='candidate_set_is_locked';
  end if;
  return coalesce(new,old);
end;
$function$;

create or replace function public.validate_seed_mapping_v4_row()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare v_seed record;
begin
  select s.id,s.run_id,r.id analysis_run_id
  into v_seed
  from public.full_corpus_theme_seeds_v4 s
  join public.theme_analysis_runs_v4 r on r.scan_run_id=s.run_id
  where s.id=new.seed_id;
  if not found or v_seed.analysis_run_id<>new.analysis_run_id then
    raise exception using errcode='23514',message='seed_mapping_analysis_run_mismatch';
  end if;
  return new;
end;
$function$;

create or replace function public.validate_census_batch_v4_row()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare v_run public.theme_analysis_runs_v4%rowtype;
begin
  select * into v_run from public.theme_analysis_runs_v4 where id=new.analysis_run_id;
  if not found or v_run.candidate_set_locked_at is null or coalesce(v_run.candidate_set_fingerprint,'')='' then
    raise exception using errcode='23514',message='census_candidate_set_not_locked';
  end if;
  if new.candidate_set_fingerprint<>v_run.candidate_set_fingerprint then
    raise exception using errcode='23514',message='census_candidate_fingerprint_mismatch';
  end if;
  if cardinality(new.article_ids)<>cardinality(array(select distinct x from unnest(new.article_ids) x)) then
    raise exception using errcode='23514',message='census_batch_duplicate_article_ids';
  end if;
  return new;
end;
$function$;

create or replace function public.validate_census_relation_v4_row()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_batch public.theme_census_batches_v4%rowtype;
  v_clean public.formal_article_analysis_text_v2%rowtype;
  v_region public.formal_source_grounded_articles_v1%rowtype;
begin
  select * into v_batch from public.theme_census_batches_v4 where id=new.census_batch_id;
  if not found or v_batch.analysis_run_id<>new.analysis_run_id or not(new.article_id=any(v_batch.article_ids)) then
    raise exception using errcode='23514',message='census_relation_batch_membership_invalid';
  end if;
  select * into v_clean from public.formal_article_analysis_text_v2 where article_id=new.article_id;
  select * into v_region from public.formal_source_grounded_articles_v1 where article_id=new.article_id;
  if not found or v_clean.article_id is null or v_region.article_id is null then
    raise exception using errcode='23514',message='census_relation_source_not_current';
  end if;
  if new.source_clean_body_sha256<>v_clean.analysis_body_sha256 or new.source_region_sha256<>v_region.source_region_sha256 then
    raise exception using errcode='23514',message='census_relation_source_hash_mismatch';
  end if;
  if new.relation<>'none' then
    if position(lower(regexp_replace(btrim(new.clean_body_anchor),'\s+',' ','g')) in lower(regexp_replace(v_clean.analysis_body,'\s+',' ','g')))=0 then
      raise exception using errcode='23514',message='census_clean_body_anchor_not_grounded';
    end if;
    if position(lower(regexp_replace(btrim(new.source_region_anchor),'\s+',' ','g')) in lower(regexp_replace(v_region.source_region_text,'\s+',' ','g')))=0 then
      raise exception using errcode='23514',message='census_source_region_anchor_not_grounded';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_validate_article_review_v4 on public.full_corpus_article_reviews_v4;
create trigger trg_validate_article_review_v4 before insert or update on public.full_corpus_article_reviews_v4 for each row execute function public.validate_article_review_v4_row();
drop trigger if exists trg_validate_theme_seed_v4 on public.full_corpus_theme_seeds_v4;
create trigger trg_validate_theme_seed_v4 before insert or update on public.full_corpus_theme_seeds_v4 for each row execute function public.validate_theme_seed_v4_row();
drop trigger if exists trg_lock_theme_candidates_v4 on public.theme_candidates_v4;
create trigger trg_lock_theme_candidates_v4 before insert or update or delete on public.theme_candidates_v4 for each row execute function public.prevent_locked_theme_set_mutation_v4();
drop trigger if exists trg_lock_seed_mappings_v4 on public.theme_seed_mappings_v4;
create trigger trg_lock_seed_mappings_v4 before insert or update or delete on public.theme_seed_mappings_v4 for each row execute function public.prevent_locked_theme_set_mutation_v4();
drop trigger if exists trg_validate_seed_mapping_v4 on public.theme_seed_mappings_v4;
create trigger trg_validate_seed_mapping_v4 before insert or update on public.theme_seed_mappings_v4 for each row execute function public.validate_seed_mapping_v4_row();
drop trigger if exists trg_validate_census_batch_v4 on public.theme_census_batches_v4;
create trigger trg_validate_census_batch_v4 before insert or update on public.theme_census_batches_v4 for each row execute function public.validate_census_batch_v4_row();
drop trigger if exists trg_validate_census_relation_v4 on public.theme_census_relations_v4;
create trigger trg_validate_census_relation_v4 before insert or update on public.theme_census_relations_v4 for each row execute function public.validate_census_relation_v4_row();

revoke all on function public.consumer_relevance_v4(text,text),public.validate_article_review_v4_row(),public.validate_theme_seed_v4_row(),public.prevent_locked_theme_set_mutation_v4(),public.validate_seed_mapping_v4_row(),public.validate_census_batch_v4_row(),public.validate_census_relation_v4_row() from public,anon,authenticated;
grant execute on function public.consumer_relevance_v4(text,text),public.validate_article_review_v4_row(),public.validate_theme_seed_v4_row(),public.prevent_locked_theme_set_mutation_v4(),public.validate_seed_mapping_v4_row(),public.validate_census_batch_v4_row(),public.validate_census_relation_v4_row() to postgres,service_role;
alter table public.articles
  add column if not exists enrichment_status text not null default 'pending',
  add column if not exists enrichment_error text;

alter table public.articles drop constraint if exists articles_enrichment_status_check;
alter table public.articles add constraint articles_enrichment_status_check check (enrichment_status in ('pending','embedded','embedding_failed'));
create index if not exists articles_enrichment_pending_idx on public.articles(enrichment_status,created_at) where (status is null or status not in ('deleted','excluded','rejected')) and enrichment_status<>'embedded';

create or replace function public.commit_source_image_articles_v1(p_image_id uuid,p_candidates jsonb,p_fallback_article_date text default null,p_replace_existing boolean default false)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_batch_id uuid; v_candidate jsonb; v_ordinal bigint; v_headline text; v_article_date text; v_ocr_text text; v_article_type text;
  v_has_table boolean; v_has_chart boolean; v_has_image boolean; v_existing public.articles%rowtype; v_created_row public.articles%rowtype;
  v_created jsonb:='[]'::jsonb; v_duplicates jsonb:='[]'::jsonb; v_retired jsonb:='[]'::jsonb; v_affected_dates text[]:='{}'::text[]; v_old_active_count integer:=0;
begin
  if p_image_id is null then raise exception using errcode='22023',message='source_image_id_required'; end if;
  if jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)=0 then raise exception using errcode='22023',message='article_candidates_required'; end if;
  if jsonb_array_length(p_candidates)>8 then raise exception using errcode='22023',message='too_many_article_candidates'; end if;
  select s.batch_id into v_batch_id from public.source_images s where s.id=p_image_id for update;
  if not found then raise exception using errcode='P0002',message='source_image_not_found'; end if;
  select count(*)::integer into v_old_active_count from public.articles a where a.source_image_id=p_image_id and (a.status is null or a.status not in ('deleted','excluded','rejected'));
  if v_old_active_count>0 and not p_replace_existing then raise exception using errcode='23514',message='source_image_already_has_active_articles',detail='Use the reprocess route for an image that already has active articles.'; end if;
  if p_replace_existing then
    select coalesce(array_agg(distinct a.article_date) filter(where coalesce(btrim(a.article_date),'')<>''),'{}'::text[]) into v_affected_dates from public.articles a where a.source_image_id=p_image_id and (a.status is null or a.status not in ('deleted','excluded','rejected'));
    with retired as (
      update public.articles a set status='deleted',duplicate_of_article_id=null,exclusion_reason='source_image_reprocessed',updated_at=now()
      where a.source_image_id=p_image_id and (a.status is null or a.status not in ('deleted','excluded','rejected')) returning a.id
    ) select coalesce(jsonb_agg(id::text order by id::text),'[]'::jsonb) into v_retired from retired;
  end if;
  for v_candidate,v_ordinal in select value,ordinality from jsonb_array_elements(p_candidates) with ordinality loop
    if jsonb_typeof(v_candidate)<>'object' then raise exception using errcode='22023',message='article_candidate_must_be_object'; end if;
    v_headline:=btrim(coalesce(v_candidate->>'headline','')); v_ocr_text:=btrim(coalesce(v_candidate->>'ocr_text','')); v_article_date:=nullif(btrim(coalesce(v_candidate->>'article_date',p_fallback_article_date,'')),'');
    v_article_type:=lower(btrim(coalesce(v_candidate->>'article_type','article'))); if v_article_type not in ('article','table','chart','caption','unknown') then v_article_type:='unknown'; end if;
    v_has_table:=lower(coalesce(v_candidate->>'has_table','false')) in ('true','1','yes'); v_has_chart:=lower(coalesce(v_candidate->>'has_chart','false')) in ('true','1','yes'); v_has_image:=lower(coalesce(v_candidate->>'has_image','false')) in ('true','1','yes');
    if v_headline='' then raise exception using errcode='22023',message='article_candidate_headline_required',detail=format('candidate index %s',v_ordinal-1); end if;
    if v_ocr_text='' then raise exception using errcode='22023',message='article_candidate_text_required',detail=format('candidate index %s',v_ordinal-1); end if;
    v_existing:=null;
    if v_article_type='article' and v_article_date is not null and public.normalize_article_headline_v1(v_headline)<>'' then
      select a.* into v_existing from public.articles a where (a.status is null or a.status not in ('deleted','excluded','rejected')) and a.article_type='article' and a.article_date=v_article_date and public.normalize_article_headline_v1(a.headline)=public.normalize_article_headline_v1(v_headline) order by length(coalesce(a.ocr_text,'')) desc,a.created_at asc,a.id asc limit 1;
      if found then v_duplicates:=v_duplicates||jsonb_build_array(jsonb_build_object('candidate_index',v_ordinal-1,'headline',v_headline,'article_date',v_article_date,'reason','existing_active_article_same_date_normalized_headline','existing_article_id',v_existing.id,'existing_headline',v_existing.headline)); continue; end if;
    end if;
    begin
      insert into public.articles(batch_id,source_image_id,headline,article_date,article_index,ocr_text,article_type,has_table,has_chart,has_image,status,enrichment_status,enrichment_error)
      values(v_batch_id,p_image_id,v_headline,v_article_date,(v_ordinal-1)::integer,v_ocr_text,v_article_type,v_has_table,v_has_chart,v_has_image,'ocr_done','pending',null) returning * into v_created_row;
    exception when unique_violation then
      if v_article_type<>'article' or v_article_date is null then raise; end if;
      select a.* into v_existing from public.articles a where (a.status is null or a.status not in ('deleted','excluded','rejected')) and a.article_type='article' and a.article_date=v_article_date and public.normalize_article_headline_v1(a.headline)=public.normalize_article_headline_v1(v_headline) order by length(coalesce(a.ocr_text,'')) desc,a.created_at asc,a.id asc limit 1;
      if not found then raise; end if;
      v_duplicates:=v_duplicates||jsonb_build_array(jsonb_build_object('candidate_index',v_ordinal-1,'headline',v_headline,'article_date',v_article_date,'reason','concurrent_existing_active_article','existing_article_id',v_existing.id,'existing_headline',v_existing.headline)); continue;
    end;
    v_created:=v_created||jsonb_build_array(to_jsonb(v_created_row));
    if v_article_date is not null then v_affected_dates:=array_append(v_affected_dates,v_article_date); end if;
  end loop;
  update public.monthly_rollups r set status='stale',error_message=null,updated_at=now() where r.month_key in (select distinct substring(value from 1 for 7) from unnest(v_affected_dates) value where value~'^\d{4}-\d{2}') and r.status<>'running';
  return jsonb_build_object('source_image_id',p_image_id,'batch_id',v_batch_id,'replace_existing',p_replace_existing,'previous_active_article_count',v_old_active_count,'retired_article_ids',v_retired,'created_articles',v_created,'duplicate_candidates',v_duplicates,'created_count',jsonb_array_length(v_created),'duplicate_count',jsonb_array_length(v_duplicates));
end;
$$;
revoke all on function public.commit_source_image_articles_v1(uuid,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.commit_source_image_articles_v1(uuid,jsonb,text,boolean) to postgres,service_role;
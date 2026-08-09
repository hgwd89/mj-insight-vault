begin;

create table if not exists public.inventory_recovered_articles_v18(
  id uuid primary key default gen_random_uuid(),
  inventory_job_id uuid not null references public.source_page_article_inventory_jobs_v1(id) on delete restrict,
  group_fingerprint text not null,
  article_id uuid not null unique references public.articles(id) on delete restrict,
  source_image_id uuid not null references public.source_images(id) on delete restrict,
  headline_anchor text not null,
  block_indices integer[] not null,
  source_region_id uuid,
  source_region_sha256 text,
  recovered_text_sha256 text,
  recovery_version text not null default 'inventory_source_region_recovery_v18',
  created_at timestamptz not null default now(),
  unique(inventory_job_id,group_fingerprint)
);
alter table public.inventory_recovered_articles_v18 enable row level security;
revoke all on public.inventory_recovered_articles_v18 from public,anon,authenticated,service_role;
grant select on public.inventory_recovered_articles_v18 to service_role;

-- Preserve the current mapping-method contract exactly and add only the recovery method.
do $do$
declare c record;v_expr text;
begin
  for c in select conname,pg_get_expr(conbin,conrelid) expr from pg_constraint where conrelid='public.source_page_article_inventory_mappings_v2'::regclass and contype='c' and pg_get_expr(conbin,conrelid) ilike '%mapping_method%' loop
    v_expr:=c.expr;
    execute format('alter table public.source_page_article_inventory_mappings_v2 drop constraint %I',c.conname);
    execute format('alter table public.source_page_article_inventory_mappings_v2 add constraint %I check ((%s) or mapping_method = %L)',c.conname,v_expr,'inventory_recovered_article_v18');
  end loop;
end
$do$;

create or replace function public.recover_blind_inventory_articles_v18(p_job_id uuid)
returns jsonb
language plpgsql security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  g record;
  t public.articles%rowtype;
  v_template_json jsonb;
  v_article_json jsonb;
  v_cols text;
  v_new_id uuid;
  v_source_image_id uuid;
  v_next_index integer;
  v_created integer:=0;
  v_promoted integer:=0;
  v_materializer text;
  v_region jsonb;
  v_region_id uuid;
  v_region_text text;
  v_region_sha text;
  v_text_sha text;
  v_unmapped integer;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found then raise exception 'inventory_recovery_v18_job_missing'; end if;

  -- Recovery is only allowed after blind discovery proofs exist and before any recovered article is formal.
  if not exists(select 1 from public.source_page_article_inventory_consensus_groups_v2 where job_id=j.id and group_kind='article') then
    return jsonb_build_object('status','no_article_groups','created',0,'promoted',0);
  end if;

  select a.* into t
  from public.source_page_article_inventory_mappings_v2 m
  join public.articles a on a.id=m.article_id
  where m.job_id=j.id
  order by a.article_index nulls last,a.id
  limit 1;
  if not found then raise exception 'inventory_recovery_v18_template_article_required'; end if;

  v_source_image_id:=coalesce(
    nullif(to_jsonb(j)->>'source_image_id','')::uuid,
    nullif(to_jsonb(j)->>'primary_source_image_id','')::uuid,
    nullif(to_jsonb(j)->>'primary_capture_id','')::uuid,
    t.source_image_id
  );
  if v_source_image_id is null then raise exception 'inventory_recovery_v18_source_image_required'; end if;

  select string_agg(quote_ident(c.column_name),',' order by c.ordinal_position)
    into v_cols
  from information_schema.columns c
  where c.table_schema='public' and c.table_name='articles'
    and coalesce(c.is_generated,'NEVER')='NEVER'
    and coalesce(c.is_identity,'NO')='NO';
  if coalesce(v_cols,'')='' then raise exception 'inventory_recovery_v18_articles_columns_missing'; end if;

  v_template_json:=to_jsonb(t);
  select coalesce(max(article_index),0)+1 into v_next_index from public.articles where source_image_id=v_source_image_id;

  for g in
    select cg.group_fingerprint,cg.headline_anchor,cg.block_indices
    from public.source_page_article_inventory_consensus_groups_v2 cg
    left join public.source_page_article_inventory_mappings_v2 m on m.job_id=cg.job_id and m.group_fingerprint=cg.group_fingerprint
    where cg.job_id=j.id and cg.group_kind='article' and m.group_fingerprint is null
    order by cg.group_fingerprint
  loop
    if coalesce(cardinality(g.block_indices),0)<1 or char_length(btrim(coalesce(g.headline_anchor,'')))<2 then
      raise exception 'inventory_recovery_v18_invalid_consensus_group:%',g.group_fingerprint;
    end if;
    v_new_id:=gen_random_uuid();
    v_article_json:=v_template_json || jsonb_build_object(
      'id',v_new_id,
      'source_image_id',v_source_image_id,
      'article_index',v_next_index,
      'headline',g.headline_anchor,
      'ocr_text',g.headline_anchor,
      'analysis_body_clean',g.headline_anchor,
      'body_sha256',encode(extensions.digest(convert_to(g.headline_anchor,'UTF8'),'sha256'),'hex'),
      'clean_body_sha256',encode(extensions.digest(convert_to(g.headline_anchor,'UTF8'),'sha256'),'hex'),
      'analysis_text_origin','pending',
      'is_hidden',false,
      'lifecycle_status','active',
      'duplicate_of_article_id',null,
      'duplicate_reason',null,
      'exclusion_reason',null,
      'created_at',now(),
      'updated_at',now()
    );
    execute format('insert into public.articles(%s) select %s from jsonb_populate_record(null::public.articles,$1) r returning id',v_cols,v_cols)
      using v_article_json into v_new_id;

    insert into public.source_page_article_inventory_mappings_v2(job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin)
    values(j.id,g.group_fingerprint,v_new_id,'inventory_recovered_article_v18',1.0,1.0);

    insert into public.inventory_recovered_articles_v18(inventory_job_id,group_fingerprint,article_id,source_image_id,headline_anchor,block_indices)
    values(j.id,g.group_fingerprint,v_new_id,v_source_image_id,g.headline_anchor,g.block_indices);
    v_created:=v_created+1;
    v_next_index:=v_next_index+1;
  end loop;

  if v_created=0 then return jsonb_build_object('status','nothing_to_recover','created',0,'promoted',0); end if;

  select p.proname into v_materializer
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('materialize_source_regions_from_inventory_v6','materialize_inventory_source_regions_v6','materialize_source_regions_from_blind_inventory_v6')
    and pg_get_function_arguments(p.oid) ilike '%uuid%'
  order by case p.proname when 'materialize_source_regions_from_inventory_v6' then 1 when 'materialize_inventory_source_regions_v6' then 2 else 3 end
  limit 1;
  if v_materializer is null then raise exception 'inventory_recovery_v18_source_region_materializer_missing'; end if;

  -- Mapping is now complete. Mark completion only inside this transaction; any materialization failure rolls it back.
  update public.source_page_article_inventory_jobs_v1
     set status='completed',error_message=null,finished_at=coalesce(finished_at,now()),updated_at=now()
   where id=j.id;
  execute format('select public.%I($1)',v_materializer) using j.id;

  for g in select * from public.inventory_recovered_articles_v18 where inventory_job_id=j.id and recovered_text_sha256 is null order by created_at,id loop
    select to_jsonb(r) into v_region
    from public.article_source_regions r
    where r.article_id=g.article_id
    order by r.created_at desc nulls last,r.id desc
    limit 1;
    if v_region is null then raise exception 'inventory_recovery_v18_source_region_missing:%',g.article_id; end if;
    v_region_id:=nullif(v_region->>'id','')::uuid;
    v_region_text:=coalesce(nullif(v_region->>'source_region_text',''),nullif(v_region->>'region_text',''),nullif(v_region->>'text',''));
    v_region_sha:=coalesce(nullif(v_region->>'source_region_sha256',''),nullif(v_region->>'region_sha256',''));
    if char_length(btrim(coalesce(v_region_text,'')))<20 then raise exception 'inventory_recovery_v18_source_region_text_too_short:%',g.article_id; end if;
    v_text_sha:=encode(extensions.digest(convert_to(v_region_text,'UTF8'),'sha256'),'hex');
    if v_region_sha is not null and v_region_sha ~ '^[0-9a-f]{64}$' and v_region_sha<>v_text_sha then raise exception 'inventory_recovery_v18_region_hash_mismatch:%',g.article_id; end if;

    update public.articles
       set ocr_text=v_region_text,
           analysis_body_clean=v_region_text,
           body_sha256=v_text_sha,
           clean_body_sha256=v_text_sha,
           analysis_text_origin='inventory_recovered_source_region_v18',
           updated_at=now()
     where id=g.article_id and analysis_text_origin='pending';
    if not found then raise exception 'inventory_recovery_v18_article_promotion_failed:%',g.article_id; end if;

    update public.inventory_recovered_articles_v18
       set source_region_id=v_region_id,source_region_sha256=coalesce(v_region_sha,v_text_sha),recovered_text_sha256=v_text_sha
     where id=g.id;
    v_promoted:=v_promoted+1;
  end loop;

  select count(*)::integer into v_unmapped
  from public.source_page_article_inventory_consensus_groups_v2 cg
  left join public.source_page_article_inventory_mappings_v2 m on m.job_id=cg.job_id and m.group_fingerprint=cg.group_fingerprint
  where cg.job_id=j.id and cg.group_kind='article' and m.group_fingerprint is null;
  if v_unmapped<>0 then raise exception 'inventory_recovery_v18_unmapped_article_groups_remain:%',v_unmapped; end if;

  return jsonb_build_object('status','recovered_requires_refreeze','created',v_created,'promoted',v_promoted,'article_ids',(select jsonb_agg(article_id order by article_id) from public.inventory_recovered_articles_v18 where inventory_job_id=j.id));
end
$function$;

revoke all on function public.recover_blind_inventory_articles_v18(uuid) from public,anon,authenticated;
grant execute on function public.recover_blind_inventory_articles_v18(uuid) to service_role;

commit;
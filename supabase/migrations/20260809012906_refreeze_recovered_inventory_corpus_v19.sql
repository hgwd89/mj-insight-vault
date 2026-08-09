begin;

create table if not exists public.inventory_recovery_refreeze_receipts_v19(
  id uuid primary key default gen_random_uuid(),
  old_freeze_receipt_ids uuid[] not null,
  new_freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id) on delete restrict,
  recovered_article_ids uuid[] not null,
  recovered_article_count integer not null check(recovered_article_count>0),
  recovery_set_fingerprint text not null check(recovery_set_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(new_freeze_receipt_id,recovery_set_fingerprint)
);
alter table public.inventory_recovery_refreeze_receipts_v19 enable row level security;
revoke all on public.inventory_recovery_refreeze_receipts_v19 from public,anon,authenticated,service_role;
grant select on public.inventory_recovery_refreeze_receipts_v19 to service_role;

create or replace function public.refreeze_recovered_inventory_corpus_v19()
returns jsonb
language plpgsql security definer
set search_path='pg_catalog','public','extensions'
as $function$
declare
  v_recovered uuid[];
  v_recovered_count integer;
  v_formal_count integer;
  v_unmapped integer;
  v_zero_name text;
  v_zero_count integer;
  v_freeze_name text;
  v_freeze_count integer;
  v_new_freeze uuid;
  v_old_freezes uuid[];
  v_fp text;
  v_receipt uuid;
begin
  select coalesce(array_agg(article_id order by article_id),'{}'::uuid[]),count(*)::integer
    into v_recovered,v_recovered_count
  from public.inventory_recovered_articles_v18
  where recovered_text_sha256 is not null;
  if v_recovered_count=0 then return jsonb_build_object('status','no_recovered_articles'); end if;

  select count(*)::integer into v_unmapped
  from public.source_page_article_inventory_consensus_groups_v2 cg
  join public.source_page_article_inventory_jobs_v1 j on j.id=cg.job_id
  left join public.source_page_article_inventory_mappings_v2 m on m.job_id=cg.job_id and m.group_fingerprint=cg.group_fingerprint
  where cg.group_kind='article' and j.status='completed' and m.group_fingerprint is null;
  if v_unmapped>0 then raise exception 'inventory_refreeze_v19_unmapped_article_groups:%',v_unmapped; end if;

  select count(*)::integer into v_formal_count from public.formal_corpus_articles_v1 a where a.id=any(v_recovered);
  if v_formal_count<>v_recovered_count then
    return jsonb_build_object('status','needs_review','reason','one_or_more_recovered_articles_fail_formal_corpus_gate','recovered',v_recovered_count,'formal',v_formal_count);
  end if;

  select array_agg(distinct freeze_receipt_id order by freeze_receipt_id) into v_old_freezes
  from public.source_page_article_inventory_jobs_v1 where freeze_receipt_id is not null;

  select count(*)::integer,min(p.proname) into v_zero_count,v_zero_name
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.pronargs=0 and p.proname not like '%v19%'
    and p.prosrc ilike '%formal_corpus_zero_audit%' and p.prosrc ilike '%insert%';
  if v_zero_count=1 then execute format('select public.%I()',v_zero_name); end if;
  if v_zero_count>1 then raise exception 'inventory_refreeze_v19_zero_audit_producer_ambiguous:%',v_zero_count; end if;

  select count(*)::integer,min(p.proname) into v_freeze_count,v_freeze_name
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.pronargs=0 and p.proname not like '%v19%'
    and p.prosrc ilike '%formal_corpus_freeze_receipts_v1%' and p.prosrc ilike '%insert%';
  if v_freeze_count<>1 then raise exception 'inventory_refreeze_v19_freeze_producer_count:%',v_freeze_count; end if;
  execute format('select public.%I()',v_freeze_name);

  select freeze_receipt_id into v_new_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_new_freeze is null then raise exception 'inventory_refreeze_v19_new_freeze_gate_not_passed'; end if;

  -- Inventory is source/page proof independent of the pre-existing article list. Carry it to the new freeze only after all recovered groups are mapped and formal.
  update public.source_page_article_inventory_jobs_v1
     set freeze_receipt_id=v_new_freeze,updated_at=now()
   where status='completed' and freeze_receipt_id is distinct from v_new_freeze;

  -- Force deterministic source-region receipts to be rebuilt for the new freeze. Article regions themselves remain source-derived and may be safely upserted.
  if to_regclass('public.source_region_materialization_receipts_v6') is not null then
    delete from public.source_region_materialization_receipts_v6 where freeze_receipt_id is distinct from v_new_freeze;
  end if;

  v_fp:=encode(extensions.digest(convert_to(array_to_string(v_recovered,','),'UTF8'),'sha256'),'hex');
  insert into public.inventory_recovery_refreeze_receipts_v19(old_freeze_receipt_ids,new_freeze_receipt_id,recovered_article_ids,recovered_article_count,recovery_set_fingerprint)
  values(coalesce(v_old_freezes,'{}'::uuid[]),v_new_freeze,v_recovered,v_recovered_count,v_fp)
  on conflict(new_freeze_receipt_id,recovery_set_fingerprint) do update set recovered_article_count=excluded.recovered_article_count
  returning id into v_receipt;
  return jsonb_build_object('status','refrozen_source_regions_refresh_required','new_freeze_receipt_id',v_new_freeze,'recovered_article_count',v_recovered_count,'receipt_id',v_receipt);
end
$function$;

create or replace function public.refresh_source_regions_after_inventory_refreeze_v19(p_batch_size integer default 25)
returns jsonb
language plpgsql security definer
set search_path='pg_catalog','public'
as $function$
declare v_freeze uuid;v_materializer text;v_count integer:=0;j record;v_remaining integer;
begin
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'source_region_refresh_v19_freeze_required'; end if;
  select p.proname into v_materializer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('materialize_source_regions_from_inventory_v6','materialize_inventory_source_regions_v6','materialize_source_regions_from_blind_inventory_v6') and pg_get_function_arguments(p.oid) ilike '%uuid%'
  order by case p.proname when 'materialize_source_regions_from_inventory_v6' then 1 when 'materialize_inventory_source_regions_v6' then 2 else 3 end limit 1;
  if v_materializer is null then raise exception 'source_region_refresh_v19_materializer_missing'; end if;
  for j in
    select x.id from public.source_page_article_inventory_jobs_v1 x
    where x.status='completed' and x.freeze_receipt_id=v_freeze
      and (to_regclass('public.source_region_materialization_receipts_v6') is null or not exists(select 1 from public.source_region_materialization_receipts_v6 r where r.inventory_job_id=x.id and r.freeze_receipt_id=v_freeze))
    order by x.created_at,x.id limit greatest(1,least(100,coalesce(p_batch_size,25)))
  loop
    execute format('select public.%I($1)',v_materializer) using j.id;
    v_count:=v_count+1;
  end loop;
  if to_regclass('public.source_region_materialization_receipts_v6') is null then
    v_remaining:=case when v_count=0 then 0 else 1 end;
  else
    select count(*)::integer into v_remaining from public.source_page_article_inventory_jobs_v1 x
    where x.status='completed' and x.freeze_receipt_id=v_freeze
      and not exists(select 1 from public.source_region_materialization_receipts_v6 r where r.inventory_job_id=x.id and r.freeze_receipt_id=v_freeze);
  end if;
  return jsonb_build_object('status',case when v_remaining=0 then 'completed' else 'progress' end,'materialized',v_count,'remaining',v_remaining,'freeze_receipt_id',v_freeze);
end
$function$;

revoke all on function public.refreeze_recovered_inventory_corpus_v19() from public,anon,authenticated;
grant execute on function public.refreeze_recovered_inventory_corpus_v19() to service_role;
revoke all on function public.refresh_source_regions_after_inventory_refreeze_v19(integer) from public,anon,authenticated;
grant execute on function public.refresh_source_regions_after_inventory_refreeze_v19(integer) to service_role;

commit;
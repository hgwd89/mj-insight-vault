-- Recovered Inventory v6: grounded raw visual evidence, sealed execution, and safe claim ordering.
-- This migration mirrors the production DB contract installed on 2026-08-10.

create table if not exists public.inventory_v3_execution_control_v1 (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  reason text,
  updated_at timestamptz not null default now(),
  freeze_receipt_id uuid,
  recovery_set_fingerprint text,
  recovery_completed_pages integer,
  sealed_at timestamptz
);

insert into public.inventory_v3_execution_control_v1(singleton,enabled,reason)
values(true,false,'initialized recovered inventory execution control')
on conflict(singleton) do nothing;

revoke all on public.inventory_v3_execution_control_v1 from public,anon,authenticated;
grant select,update on public.inventory_v3_execution_control_v1 to service_role;

create or replace function public.invalidate_inventory_v3_execution_control_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
begin
  update public.inventory_v3_execution_control_v1
  set enabled=false,
      reason='source/formal corpus mutation invalidated sealed inventory execution',
      updated_at=now()
  where singleton=true and enabled=true;
  return coalesce(new,old);
end
$function$;

drop trigger if exists trg_invalidate_inventory_v3_on_articles on public.articles;
create trigger trg_invalidate_inventory_v3_on_articles
after insert or update or delete on public.articles
for each statement execute function public.invalidate_inventory_v3_execution_control_v1();

drop trigger if exists trg_invalidate_inventory_v3_on_source_images on public.source_images;
create trigger trg_invalidate_inventory_v3_on_source_images
after insert or update or delete on public.source_images
for each statement execute function public.invalidate_inventory_v3_execution_control_v1();

create or replace function public.seal_inventory_v3_execution_v2(
  p_reason text default 'sealed recovered inventory execution'
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  v_freeze uuid;
  v_recovery_gate text;
  v_pages integer;
  v_fp text;
  v_jobs integer;
begin
  select freeze_receipt_id into v_freeze
  from public.formal_corpus_freeze_gate_v2
  where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'inventory_execution_v2_freeze_not_passed'; end if;

  select recovery_gate,completed into v_recovery_gate,v_pages
  from public.source_page_ocr_recovery_gate_v1;
  if v_recovery_gate<>'passed' or v_pages<>531 then
    raise exception 'inventory_execution_v2_page_recovery_not_passed';
  end if;

  select count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(
           page_identity_source_image_id::text||':'||
           coalesce(source_binary_sha256,'')||':'||
           coalesce(fresh_google_response_sha256,'')||':'||
           coalesce(fresh_google_text_sha256,'')||':'||
           coalesce(fresh_block_count::text,''),
           '|' order by page_identity_source_image_id::text),''),'UTF8'),'sha256'),'hex')
    into v_jobs,v_fp
  from public.source_page_ocr_recovery_jobs_v1
  where status='completed';

  if v_jobs<>531 or coalesce(v_fp,'')='' then
    raise exception 'inventory_execution_v2_recovery_receipts_incomplete';
  end if;

  if exists(
    select 1
    from public.source_page_article_inventory_jobs_v1
    where inventory_version='page_article_inventory_v4_recovered_ocr'
      and freeze_receipt_id is distinct from v_freeze
  ) then
    raise exception 'inventory_execution_v2_inventory_freeze_mismatch';
  end if;

  update public.inventory_v3_execution_control_v1
  set enabled=true,
      reason=coalesce(nullif(btrim(p_reason),''),'sealed recovered inventory execution'),
      freeze_receipt_id=v_freeze,
      recovery_set_fingerprint=v_fp,
      recovery_completed_pages=v_pages,
      sealed_at=now(),
      updated_at=now()
  where singleton=true;

  return jsonb_build_object(
    'enabled',true,
    'freeze_receipt_id',v_freeze,
    'recovery_set_fingerprint',v_fp,
    'recovery_completed_pages',v_pages
  );
end
$function$;

create table if not exists public.source_page_inventory_visual_region_evidence_v6 (
  job_id uuid not null references public.source_page_article_inventory_jobs_v1(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic','adjudicator')),
  article_seq integer not null check(article_seq between 1 and 12),
  headline_hint text not null,
  confidence numeric not null check(confidence between 0 and 1),
  regions jsonb not null check(jsonb_typeof(regions)='array'),
  reason text not null,
  grounded_block_count integer not null default 0 check(grounded_block_count>=0),
  ambiguous_block_count integer not null default 0 check(ambiguous_block_count>=0),
  dropped_from_partition boolean not null default false,
  model text not null,
  provider_response_id text not null,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default now(),
  primary key(job_id,pass_kind,article_seq)
);

revoke all on public.source_page_inventory_visual_region_evidence_v6 from public,anon,authenticated;
grant select,insert,update,delete on public.source_page_inventory_visual_region_evidence_v6 to service_role;

create or replace function public.claim_source_page_article_inventory_job_v3(
  p_job_id uuid default null::uuid,
  p_lease_seconds integer default 240
)
returns setof public.source_page_article_inventory_jobs_v1
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $function$
declare
  v_id uuid;
  v_status text;
  v_token uuid:=gen_random_uuid();
  v_enabled boolean;
  v_freeze uuid;
  v_pages integer;
  v_lease integer;
begin
  select enabled,freeze_receipt_id,recovery_completed_pages
    into v_enabled,v_freeze,v_pages
  from public.inventory_v3_execution_control_v1
  where singleton=true;

  if not coalesce(v_enabled,false) or v_freeze is null or v_pages<>531 then return; end if;

  if (select count(*) from public.source_page_ocr_recovery_jobs_v1 where status='completed')<>531
     or exists(select 1 from public.source_page_ocr_recovery_jobs_v1 where status<>'completed') then
    update public.inventory_v3_execution_control_v1
    set enabled=false,reason='page recovery state drifted after execution seal',updated_at=now()
    where singleton=true;
    return;
  end if;

  if p_job_id is null then
    select j.id,j.status into v_id,v_status
    from public.source_page_article_inventory_jobs_v1 j
    where j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.freeze_receipt_id=v_freeze
      and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
      and j.attempt_count<4
    order by j.requires_third_pass asc,
      ((select count(*) from public.source_page_article_inventory_pass_runs_v1 pr where pr.job_id=j.id)
       +(select count(*) from public.source_page_article_inventory_mapping_pass_runs_v2 mr where mr.job_id=j.id)) desc,
      j.existing_article_count asc,
      j.block_count asc,
      j.created_at,
      j.id
    for update skip locked
    limit 1;
  else
    select j.id,j.status into v_id,v_status
    from public.source_page_article_inventory_jobs_v1 j
    where j.id=p_job_id
      and j.inventory_version='page_article_inventory_v4_recovered_ocr'
      and j.freeze_receipt_id=v_freeze
      and (j.status='queued' or (j.status='running' and coalesce(j.lease_expires_at,'epoch'::timestamptz)<now()))
      and j.attempt_count<4
    for update skip locked;
  end if;

  if v_id is null then return; end if;
  v_lease:=420;

  update public.source_page_article_inventory_jobs_v1
  set status='running',
      lease_token=v_token,
      lease_expires_at=now()+make_interval(secs=>v_lease),
      attempt_count=attempt_count+case when v_status='running' then 1 else 0 end,
      error_message=null,
      updated_at=now()
  where id=v_id;

  return query select * from public.source_page_article_inventory_jobs_v1 where id=v_id;
end
$function$;

create or replace function public.replace_source_page_article_inventory_pass_v1(
  p_job_id uuid,
  p_lease_token uuid,
  p_pass_kind text,
  p_model text,
  p_provider_response_id text,
  p_prompt_sha256 text,
  p_response_sha256 text,
  p_groups jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  g jsonb;
  v_indices integer[];
  v_fp text;
  v_inserted integer:=0;
  v_covered integer;
  v_distinct integer;
  v_required integer;
  v_anchor_ok boolean;
  v_page_article boolean;
  v_min_conf numeric;
begin
  if p_pass_kind not in ('mapper','critic','adjudicator') then raise exception 'inventory_v1_bad_pass_kind'; end if;
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'inventory_v1_lease_invalid';
  end if;
  if p_pass_kind='adjudicator' and not j.requires_third_pass then raise exception 'inventory_v1_adjudicator_not_required'; end if;
  if jsonb_typeof(p_groups)<>'array' or jsonb_array_length(p_groups)=0 then raise exception 'inventory_v1_groups_required'; end if;
  if exists(
    select 1 from public.source_page_article_inventory_pass_runs_v1
    where job_id=j.id and (model=p_model or provider_response_id=p_provider_response_id or prompt_sha256=p_prompt_sha256)
  ) then raise exception 'inventory_v1_independent_pass_required'; end if;

  v_min_conf:=case when j.inventory_version='page_article_inventory_v4_recovered_ocr' then 0.60 else 0.80 end;

  delete from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind=p_pass_kind;
  delete from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id and pass_kind=p_pass_kind;
  insert into public.source_page_article_inventory_pass_runs_v1(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256)
  values(j.id,p_pass_kind,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256);

  for g in select value from jsonb_array_elements(p_groups) loop
    select array_agg(distinct (e.v)::integer order by (e.v)::integer)
      into v_indices
    from jsonb_array_elements_text(coalesce(g->'block_indices','[]'::jsonb)) e(v);

    if coalesce(array_length(v_indices,1),0)=0 then raise exception 'inventory_v1_empty_group'; end if;
    if exists(
      select 1 from unnest(v_indices) x
      where not exists(
        select 1 from public.source_page_article_inventory_blocks_v1 b
        where b.job_id=j.id and b.block_index=x and b.source_ocr_json_sha256=j.source_ocr_json_sha256
      )
    ) then raise exception 'inventory_v1_unknown_block'; end if;
    if coalesce((g->>'confidence')::numeric,0)<v_min_conf then raise exception 'inventory_v1_low_confidence_group'; end if;

    if g->>'group_kind'='article' then
      if coalesce(btrim(g->>'headline_anchor'),'')='' then raise exception 'inventory_v1_article_anchor_required'; end if;
      select exists(
        select 1 from public.source_page_article_inventory_blocks_v1 b
        where b.job_id=j.id and b.block_index=any(v_indices)
          and position(lower(g->>'headline_anchor') in lower(b.block_text))>0
      ) into v_anchor_ok;
      if not v_anchor_ok then raise exception 'inventory_v1_anchor_not_in_group'; end if;
      if nullif(g->>'mapped_article_id','') is not null then
        select exists(
          select 1 from public.formal_corpus_articles_v1 a
          join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id
          where a.id=(g->>'mapped_article_id')::uuid
            and m.page_identity_source_image_id=j.page_identity_source_image_id
        ) into v_page_article;
        if not v_page_article then raise exception 'inventory_v1_mapped_article_not_on_page'; end if;
      end if;
    elsif g->>'group_kind'='non_article' then
      if coalesce(btrim(g->>'non_article_role'),'')='' then raise exception 'inventory_v1_non_article_role_required'; end if;
    else
      raise exception 'inventory_v1_bad_group_kind';
    end if;

    v_fp:=encode(extensions.digest(convert_to(
      j.source_ocr_json_sha256||':'||coalesce(g->>'group_kind','')||':'||array_to_string(v_indices,','),
      'UTF8'),'sha256'),'hex');

    insert into public.source_page_article_inventory_groups_v1(
      job_id,pass_kind,group_kind,group_fingerprint,block_indices,mapped_article_id,headline_anchor,non_article_role,confidence,reason
    ) values(
      j.id,p_pass_kind,g->>'group_kind',v_fp,v_indices,nullif(g->>'mapped_article_id','')::uuid,
      nullif(g->>'headline_anchor',''),nullif(g->>'non_article_role',''),(g->>'confidence')::numeric,g->>'reason'
    );
    v_inserted:=v_inserted+1;
  end loop;

  select count(*)::integer,count(distinct x)::integer
    into v_covered,v_distinct
  from public.source_page_article_inventory_groups_v1 ig
  cross join lateral unnest(ig.block_indices) x
  where ig.job_id=j.id and ig.pass_kind=p_pass_kind;

  select count(*)::integer into v_required
  from public.source_page_article_inventory_blocks_v1 b
  where b.job_id=j.id and b.source_ocr_json_sha256=j.source_ocr_json_sha256;

  if v_covered<>v_required or v_distinct<>v_required then
    raise exception 'inventory_v1_block_partition_not_complete: covered=% distinct=% expected=%',v_covered,v_distinct,v_required;
  end if;

  return jsonb_build_object(
    'status','stored','groups',v_inserted,'blocks',v_required,
    'inventory_version',j.inventory_version,'min_confidence',v_min_conf
  );
end
$function$;

begin;

-- Inventory v3 keeps the original blind pass receipts, but turns mapper/critic
-- disagreement into an explicit third-pass requirement. A consensus is accepted
-- only when two complete partitions are identical; groups are never mixed across
-- passes.

create or replace function public.record_source_page_article_inventory_pass_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_pass_kind text,
  p_model text,
  p_provider_response_id text,
  p_prompt_sha256 text,
  p_response_sha256 text,
  p_groups jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  v_result jsonb;
  v_mapper text[];
  v_critic text[];
begin
  select public.replace_source_page_article_inventory_pass_v1(
    p_job_id,p_lease_token,p_pass_kind,p_model,p_provider_response_id,
    p_prompt_sha256,p_response_sha256,p_groups
  ) into v_result;

  if p_pass_kind='critic' then
    select coalesce(array_agg(group_fingerprint order by group_fingerprint),array[]::text[])
      into v_mapper
      from public.source_page_article_inventory_groups_v1
     where job_id=p_job_id and pass_kind='mapper';
    select coalesce(array_agg(group_fingerprint order by group_fingerprint),array[]::text[])
      into v_critic
      from public.source_page_article_inventory_groups_v1
     where job_id=p_job_id and pass_kind='critic';

    if v_mapper is distinct from v_critic then
      update public.source_page_article_inventory_jobs_v1
         set requires_third_pass=true,
             updated_at=now()
       where id=p_job_id
         and status='running'
         and lease_token is not distinct from p_lease_token;
      v_result:=v_result||jsonb_build_object('requires_third_pass',true,'disagreement_detected',true);
    else
      v_result:=v_result||jsonb_build_object('disagreement_detected',false);
    end if;
  end if;

  return v_result;
end
$function$;

create or replace function public.inventory_consensus_source_v3(p_job_id uuid)
returns text
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_mapper text[];
  v_critic text[];
  v_adjudicator text[];
  v_adjudicator_present boolean;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id;
  if not found then return null; end if;

  select coalesce(array_agg(group_fingerprint order by group_fingerprint),array[]::text[])
    into v_mapper from public.source_page_article_inventory_groups_v1
   where job_id=p_job_id and pass_kind='mapper';
  select coalesce(array_agg(group_fingerprint order by group_fingerprint),array[]::text[])
    into v_critic from public.source_page_article_inventory_groups_v1
   where job_id=p_job_id and pass_kind='critic';
  select coalesce(array_agg(group_fingerprint order by group_fingerprint),array[]::text[])
    into v_adjudicator from public.source_page_article_inventory_groups_v1
   where job_id=p_job_id and pass_kind='adjudicator';
  select exists(
    select 1 from public.source_page_article_inventory_pass_runs_v1
     where job_id=p_job_id and pass_kind='adjudicator'
  ) into v_adjudicator_present;

  if coalesce(array_length(v_mapper,1),0)=0 or coalesce(array_length(v_critic,1),0)=0 then
    return null;
  end if;

  if not j.requires_third_pass then
    if v_mapper=v_critic then return 'mapper'; end if;
    return null;
  end if;

  if not v_adjudicator_present or coalesce(array_length(v_adjudicator,1),0)=0 then
    return null;
  end if;

  if v_mapper=v_critic then return 'mapper'; end if;
  if v_mapper=v_adjudicator then return 'adjudicator'; end if;
  if v_critic=v_adjudicator then return 'adjudicator'; end if;
  return null;
end
$function$;

create or replace view public.source_page_article_inventory_consensus_groups_v3
with (security_invoker=true)
as
with selected as (
  select j.id as job_id,
         j.inventory_source_image_id,
         public.inventory_consensus_source_v3(j.id) as selected_pass
    from public.source_page_article_inventory_jobs_v1 j
)
select g.job_id,
       g.group_fingerprint,
       g.block_indices,
       g.headline_anchor,
       g.confidence,
       s.selected_pass,
       string_agg(b.block_text,E'\n---\n' order by b.y_min,b.x_min,b.block_index) as group_text
  from selected s
  join public.source_page_article_inventory_groups_v1 g
    on g.job_id=s.job_id
   and g.pass_kind=s.selected_pass
   and g.group_kind='article'
  join public.source_ocr_blocks_v1 b
    on b.source_image_id=s.inventory_source_image_id
   and b.page_index=0
   and b.block_index=any(g.block_indices)
 where s.selected_pass is not null
 group by g.job_id,g.group_fingerprint,g.block_indices,g.headline_anchor,g.confidence,s.selected_pass;

create or replace function public.inventory_mapping_candidates_v3(p_job_id uuid)
returns table(
  group_fingerprint text,
  article_id uuid,
  score numeric,
  group_rank bigint,
  article_rank bigint,
  group_margin numeric
)
language sql
stable
security definer
set search_path=pg_catalog,public,extensions
as $function$
with j as (
  select * from public.source_page_article_inventory_jobs_v1 where id=p_job_id
), arts as (
  select distinct a.id,a.headline
    from public.formal_corpus_articles_v1 a
    join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id
    join j on j.page_identity_source_image_id=m.page_identity_source_image_id
), scores as (
  select g.group_fingerprint,
         a.id as article_id,
         greatest(
           similarity(lower(coalesce(a.headline,'')),lower(coalesce(g.headline_anchor,''))),
           similarity(lower(coalesce(a.headline,'')),lower(left(coalesce(g.group_text,''),240)))
         )::numeric as score
    from public.source_page_article_inventory_consensus_groups_v3 g
    join arts a on true
   where g.job_id=p_job_id
), ranked as (
  select *,
         row_number() over(partition by group_fingerprint order by score desc,article_id) as group_rank,
         row_number() over(partition by article_id order by score desc,group_fingerprint) as article_rank,
         score-lead(score) over(partition by group_fingerprint order by score desc,article_id) as group_margin
    from scores
)
select group_fingerprint,article_id,score,group_rank,article_rank,coalesce(group_margin,score)
  from ranked;
$function$;

create or replace function public.resolve_inventory_mapping_auto_v3(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_groups integer;
  v_resolved integer;
  v_total_resolved integer;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'inventory_v3_auto_map_lease_invalid';
  end if;
  if public.inventory_consensus_source_v3(j.id) is null then
    raise exception 'inventory_v3_consensus_unresolved';
  end if;

  delete from public.source_page_article_inventory_mappings_v2
   where job_id=j.id and mapping_method='auto_reciprocal_headline';

  select count(*)::integer into v_groups
    from public.source_page_article_inventory_consensus_groups_v3
   where job_id=j.id;

  insert into public.source_page_article_inventory_mappings_v2(
    job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin
  )
  select j.id,c.group_fingerprint,c.article_id,'auto_reciprocal_headline',c.score,c.group_margin
    from public.inventory_mapping_candidates_v3(j.id) c
   where c.group_rank=1
     and c.article_rank=1
     and c.score>=0.18
     and c.group_margin>=0.03
  on conflict(job_id,group_fingerprint) do nothing;
  get diagnostics v_resolved=row_count;

  select count(*)::integer into v_total_resolved
    from public.source_page_article_inventory_mappings_v2 where job_id=j.id;

  return jsonb_build_object(
    'status',case when v_total_resolved=v_groups then 'resolved' else 'partial' end,
    'group_count',v_groups,
    'auto_resolved',v_resolved,
    'total_resolved',v_total_resolved,
    'unresolved',v_groups-v_total_resolved
  );
end
$function$;

create or replace function public.replace_inventory_mapping_pass_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_pass_kind text,
  p_model text,
  p_provider_response_id text,
  p_prompt_sha256 text,
  p_response_sha256 text,
  p_mappings jsonb
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  m jsonb;
  v_groups integer;
  v_rows integer;
begin
  if p_pass_kind not in ('mapper','critic') then raise exception 'inventory_mapping_v3_bad_pass_kind'; end if;
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'inventory_mapping_v3_lease_invalid';
  end if;
  if public.inventory_consensus_source_v3(j.id) is null then raise exception 'inventory_mapping_v3_consensus_unresolved'; end if;
  if jsonb_typeof(p_mappings)<>'array' then raise exception 'inventory_mapping_v3_array_required'; end if;

  select count(*)::integer into v_groups
    from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id;
  if jsonb_array_length(p_mappings)<>v_groups then raise exception 'inventory_mapping_v3_row_count_mismatch'; end if;
  if exists(
    select 1 from public.source_page_article_inventory_mapping_pass_runs_v2
     where job_id=j.id and (model=p_model or provider_response_id=p_provider_response_id or prompt_sha256=p_prompt_sha256)
  ) then raise exception 'inventory_mapping_v3_independent_pass_required'; end if;

  delete from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind=p_pass_kind;
  delete from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id and pass_kind=p_pass_kind;
  insert into public.source_page_article_inventory_mapping_pass_runs_v2(
    job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256
  ) values(j.id,p_pass_kind,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256);

  for m in select value from jsonb_array_elements(p_mappings) loop
    if not exists(
      select 1 from public.source_page_article_inventory_consensus_groups_v3 g
       where g.job_id=j.id and g.group_fingerprint=m->>'group_fingerprint'
    ) then raise exception 'inventory_mapping_v3_unknown_group'; end if;
    if not exists(
      select 1
        from public.formal_corpus_articles_v1 a
        join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id
       where a.id=(m->>'article_id')::uuid
         and cm.page_identity_source_image_id=j.page_identity_source_image_id
    ) then raise exception 'inventory_mapping_v3_article_not_on_page'; end if;
    if coalesce((m->>'confidence')::numeric,0)<0.80 then raise exception 'inventory_mapping_v3_low_confidence'; end if;

    insert into public.source_page_article_inventory_mapping_stage_v2(
      job_id,pass_kind,group_fingerprint,article_id,confidence,rationale
    ) values(
      j.id,p_pass_kind,m->>'group_fingerprint',(m->>'article_id')::uuid,
      (m->>'confidence')::numeric,m->>'rationale'
    );
  end loop;

  select count(*)::integer into v_rows
    from public.source_page_article_inventory_mapping_stage_v2
   where job_id=j.id and pass_kind=p_pass_kind;
  if v_rows<>v_groups
     or (select count(distinct article_id) from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind=p_pass_kind)<>v_groups
  then raise exception 'inventory_mapping_v3_not_bijective'; end if;

  return jsonb_build_object('status','stored','rows',v_rows);
end
$function$;

create or replace function public.finalize_source_page_article_inventory_job_v3(
  p_job_id uuid,
  p_lease_token uuid
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $function$
declare
  j public.source_page_article_inventory_jobs_v1%rowtype;
  v_set record;
  v_selected_pass text;
  v_inventory_articles integer;
  v_passes integer;
  v_resolved integer;
  v_map_passes integer;
begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'inventory_v3_finalize_lease_invalid';
  end if;
  if not exists(
    select 1 from public.formal_corpus_freeze_gate_v2
     where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id
  ) then raise exception 'inventory_v3_freeze_stale'; end if;

  select * into v_set from public.inventory_page_article_set_proof_v1(j.page_identity_source_image_id);
  if v_set.article_count<>j.existing_article_count or v_set.article_set_fingerprint<>j.page_article_set_fingerprint then
    raise exception 'inventory_v3_page_article_set_stale';
  end if;

  select count(*)::integer into v_passes
    from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id;
  if (j.requires_third_pass and v_passes<>3) or (not j.requires_third_pass and v_passes<>2) then
    raise exception 'inventory_v3_blind_pass_receipts_incomplete';
  end if;

  v_selected_pass:=public.inventory_consensus_source_v3(j.id);
  if v_selected_pass is null then
    update public.source_page_article_inventory_jobs_v1
       set status='needs_review',lease_token=null,lease_expires_at=null,
           error_message='blind inventory v3: no two complete partitions agree',updated_at=now()
     where id=j.id;
    return jsonb_build_object('status','needs_review','reason','blind_inventory_v3_no_pair_consensus');
  end if;

  select count(*)::integer into v_inventory_articles
    from public.source_page_article_inventory_consensus_groups_v3 where job_id=j.id;

  if v_inventory_articles<>j.existing_article_count then
    update public.source_page_article_inventory_jobs_v1
       set status=case when v_inventory_articles>j.existing_article_count then 'discovery_required' else 'needs_review' end,
           lease_token=null,lease_expires_at=null,
           error_message=format('blind inventory v3 article count %s differs from frozen count %s',v_inventory_articles,j.existing_article_count),
           updated_at=now(),
           finished_at=case when v_inventory_articles>j.existing_article_count then now() else null end
     where id=j.id;
    return jsonb_build_object(
      'status',case when v_inventory_articles>j.existing_article_count then 'discovery_required' else 'needs_review' end,
      'inventory_article_count',v_inventory_articles,
      'frozen_article_count',j.existing_article_count,
      'consensus_source',v_selected_pass
    );
  end if;

  perform public.resolve_inventory_mapping_auto_v3(j.id,j.lease_token);
  select count(*)::integer into v_resolved
    from public.source_page_article_inventory_mappings_v2 where job_id=j.id;

  if v_resolved<j.existing_article_count then
    select count(*)::integer into v_map_passes
      from public.source_page_article_inventory_mapping_pass_runs_v2 where job_id=j.id;
    if v_map_passes<>2 or exists(
      (select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='mapper'
       except
       select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='critic')
      union all
      (select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='critic'
       except
       select group_fingerprint,article_id from public.source_page_article_inventory_mapping_stage_v2 where job_id=j.id and pass_kind='mapper')
    ) then
      update public.source_page_article_inventory_jobs_v1
         set status='needs_review',lease_token=null,lease_expires_at=null,
             error_message=format('inventory v3 article mapping review required: resolved %s/%s',v_resolved,j.existing_article_count),
             updated_at=now()
       where id=j.id;
      return jsonb_build_object('status','needs_review','reason','article_mapping_v3_review_required','auto_resolved',v_resolved,'expected',j.existing_article_count);
    end if;

    insert into public.source_page_article_inventory_mappings_v2(
      job_id,group_fingerprint,article_id,mapping_method,mapping_score,mapping_margin
    )
    select j.id,m.group_fingerprint,m.article_id,'dual_review',least(m.confidence,c.confidence),null
      from public.source_page_article_inventory_mapping_stage_v2 m
      join public.source_page_article_inventory_mapping_stage_v2 c
        on c.job_id=m.job_id
       and c.pass_kind='critic'
       and c.group_fingerprint=m.group_fingerprint
       and c.article_id=m.article_id
     where m.job_id=j.id and m.pass_kind='mapper'
    on conflict(job_id,group_fingerprint) do nothing;
  end if;

  select count(*)::integer into v_resolved
    from public.source_page_article_inventory_mappings_v2 where job_id=j.id;
  if v_resolved<>j.existing_article_count
     or (select count(distinct article_id) from public.source_page_article_inventory_mappings_v2 where job_id=j.id)<>j.existing_article_count
  then raise exception 'inventory_v3_final_mapping_not_bijective'; end if;

  if exists(
    (select article_id from public.source_page_article_inventory_mappings_v2 where job_id=j.id
     except
     select a.id from public.formal_corpus_articles_v1 a
       join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id
      where cm.page_identity_source_image_id=j.page_identity_source_image_id)
    union all
    (select a.id from public.formal_corpus_articles_v1 a
       join public.source_page_capture_map_v1 cm on cm.source_image_id=a.source_image_id
      where cm.page_identity_source_image_id=j.page_identity_source_image_id
     except
     select article_id from public.source_page_article_inventory_mappings_v2 where job_id=j.id)
  ) then raise exception 'inventory_v3_mapping_article_set_mismatch'; end if;

  update public.source_page_article_inventory_jobs_v1
     set status='completed',lease_token=null,lease_expires_at=null,error_message=null,
         updated_at=now(),finished_at=now()
   where id=j.id;

  return jsonb_build_object(
    'status','completed',
    'inventory_article_count',v_inventory_articles,
    'mapped_articles',v_resolved,
    'third_pass',j.requires_third_pass,
    'consensus_source',v_selected_pass,
    'inventory_version','page_article_inventory_v3_pair_consensus'
  );
end
$function$;

revoke all on function public.record_source_page_article_inventory_pass_v3(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.inventory_consensus_source_v3(uuid) from public,anon,authenticated;
revoke all on function public.inventory_mapping_candidates_v3(uuid) from public,anon,authenticated;
revoke all on function public.resolve_inventory_mapping_auto_v3(uuid,uuid) from public,anon,authenticated;
revoke all on function public.replace_inventory_mapping_pass_v3(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_source_page_article_inventory_job_v3(uuid,uuid) from public,anon,authenticated;
revoke all on public.source_page_article_inventory_consensus_groups_v3 from public,anon,authenticated;

grant execute on function public.record_source_page_article_inventory_pass_v3(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.inventory_consensus_source_v3(uuid) to service_role;
grant execute on function public.inventory_mapping_candidates_v3(uuid) to service_role;
grant execute on function public.resolve_inventory_mapping_auto_v3(uuid,uuid) to service_role;
grant execute on function public.replace_inventory_mapping_pass_v3(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.finalize_source_page_article_inventory_job_v3(uuid,uuid) to service_role;
grant select on public.source_page_article_inventory_consensus_groups_v3 to service_role;

commit;

create or replace function public.enqueue_source_page_article_inventory_jobs_v1()
returns integer
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_freeze uuid;v_count integer;begin
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'inventory_v1_freeze_not_ready';end if;
  insert into public.source_page_article_inventory_jobs_v1(page_identity_source_image_id,inventory_source_image_id,freeze_receipt_id,source_ocr_json_sha256,block_count,existing_article_count,page_article_set_fingerprint,requires_third_pass)
  select c.page_identity_source_image_id,c.inventory_source_image_id,v_freeze,c.source_ocr_json_sha256,c.block_count,c.existing_article_count,p.article_set_fingerprint,c.requires_third_pass
  from public.source_page_inventory_capture_v1 c
  cross join lateral public.inventory_page_article_set_proof_v1(c.page_identity_source_image_id) p
  where p.article_count=c.existing_article_count
  on conflict(page_identity_source_image_id,freeze_receipt_id,inventory_version) do nothing;
  get diagnostics v_count=row_count;return v_count;
end
$$;
revoke all on function public.enqueue_source_page_article_inventory_jobs_v1() from public,anon,authenticated;
grant execute on function public.enqueue_source_page_article_inventory_jobs_v1() to service_role;

create or replace function public.claim_source_page_article_inventory_job_v1(p_lease_seconds integer default 420)
returns setof public.source_page_article_inventory_jobs_v1
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();begin
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then raise exception 'inventory_v1_freeze_stale';end if;
  select id into v_id from public.source_page_article_inventory_jobs_v1
  where (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now())) and attempt_count<4
  order by requires_third_pass desc,created_at for update skip locked limit 1;
  if v_id is null then return;end if;
  update public.source_page_article_inventory_jobs_v1 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(900,coalesce(p_lease_seconds,420)))),attempt_count=attempt_count+1,updated_at=now(),error_message=null where id=v_id;
  return query select * from public.source_page_article_inventory_jobs_v1 where id=v_id;
end
$$;
revoke all on function public.claim_source_page_article_inventory_job_v1(integer) from public,anon,authenticated;
grant execute on function public.claim_source_page_article_inventory_job_v1(integer) to service_role;

create or replace function public.replace_source_page_article_inventory_pass_v1(
  p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_groups jsonb
) returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public,extensions
as $$
declare j public.source_page_article_inventory_jobs_v1%rowtype;g jsonb;v_indices integer[];v_fp text;v_inserted integer:=0;v_covered integer;v_distinct integer;v_required integer;v_anchor_ok boolean;v_page_article boolean;begin
  if p_pass_kind not in ('mapper','critic','adjudicator') then raise exception 'inventory_v1_bad_pass_kind';end if;
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'inventory_v1_lease_invalid';end if;
  if p_pass_kind='adjudicator' and not j.requires_third_pass then raise exception 'inventory_v1_adjudicator_not_required';end if;
  if jsonb_typeof(p_groups)<>'array' or jsonb_array_length(p_groups)=0 then raise exception 'inventory_v1_groups_required';end if;
  if exists(select 1 from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id and (model=p_model or provider_response_id=p_provider_response_id or prompt_sha256=p_prompt_sha256)) then raise exception 'inventory_v1_independent_pass_required';end if;
  delete from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind=p_pass_kind;
  delete from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id and pass_kind=p_pass_kind;
  insert into public.source_page_article_inventory_pass_runs_v1(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256) values(j.id,p_pass_kind,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256);
  for g in select value from jsonb_array_elements(p_groups) loop
    select array_agg(distinct (e.v)::integer order by (e.v)::integer) into v_indices from jsonb_array_elements_text(coalesce(g->'block_indices','[]'::jsonb)) e(v);
    if coalesce(array_length(v_indices,1),0)=0 then raise exception 'inventory_v1_empty_group';end if;
    if exists(select 1 from unnest(v_indices) x where not exists(select 1 from public.source_ocr_blocks_v1 b where b.source_image_id=j.inventory_source_image_id and b.page_index=0 and b.block_index=x and b.source_ocr_json_sha256=j.source_ocr_json_sha256)) then raise exception 'inventory_v1_unknown_block';end if;
    if coalesce((g->>'confidence')::numeric,0)<0.80 then raise exception 'inventory_v1_low_confidence_group';end if;
    if g->>'group_kind'='article' then
      if coalesce(btrim(g->>'headline_anchor'),'')='' then raise exception 'inventory_v1_article_anchor_required';end if;
      select exists(select 1 from public.source_ocr_blocks_v1 b where b.source_image_id=j.inventory_source_image_id and b.block_index=any(v_indices) and position(lower(g->>'headline_anchor') in lower(b.block_text))>0) into v_anchor_ok;
      if not v_anchor_ok then raise exception 'inventory_v1_anchor_not_in_group';end if;
      if nullif(g->>'mapped_article_id','') is not null then
        select exists(select 1 from public.formal_corpus_articles_v1 a join public.source_page_capture_map_v1 m on m.source_image_id=a.source_image_id where a.id=(g->>'mapped_article_id')::uuid and m.page_identity_source_image_id=j.page_identity_source_image_id) into v_page_article;
        if not v_page_article then raise exception 'inventory_v1_mapped_article_not_on_page';end if;
      end if;
    elsif g->>'group_kind'='non_article' then
      if coalesce(btrim(g->>'non_article_role'),'')='' then raise exception 'inventory_v1_non_article_role_required';end if;
    else raise exception 'inventory_v1_bad_group_kind';end if;
    v_fp:=encode(extensions.digest(convert_to(j.source_ocr_json_sha256||':'||coalesce(g->>'group_kind','')||':'||array_to_string(v_indices,','),'UTF8'),'sha256'),'hex');
    insert into public.source_page_article_inventory_groups_v1(job_id,pass_kind,group_kind,group_fingerprint,block_indices,mapped_article_id,headline_anchor,non_article_role,confidence,reason)
    values(j.id,p_pass_kind,g->>'group_kind',v_fp,v_indices,nullif(g->>'mapped_article_id','')::uuid,nullif(g->>'headline_anchor',''),nullif(g->>'non_article_role',''),(g->>'confidence')::numeric,g->>'reason');
    v_inserted:=v_inserted+1;
  end loop;
  select count(*)::integer,count(distinct x)::integer into v_covered,v_distinct from public.source_page_article_inventory_groups_v1 ig cross join lateral unnest(ig.block_indices) x where ig.job_id=j.id and ig.pass_kind=p_pass_kind;
  select count(*)::integer into v_required from public.source_ocr_blocks_v1 b where b.source_image_id=j.inventory_source_image_id and b.page_index=0 and b.source_ocr_json_sha256=j.source_ocr_json_sha256;
  if v_covered<>v_required or v_distinct<>v_required then raise exception 'inventory_v1_block_partition_not_complete: covered=% distinct=% expected=%',v_covered,v_distinct,v_required;end if;
  return jsonb_build_object('status','stored','groups',v_inserted,'blocks',v_required);
end
$$;
revoke all on function public.replace_source_page_article_inventory_pass_v1(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.replace_source_page_article_inventory_pass_v1(uuid,uuid,text,text,text,text,text,jsonb) to service_role;

create or replace function public.finalize_source_page_article_inventory_job_v1(p_job_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare j public.source_page_article_inventory_jobs_v1%rowtype;v_passes integer;v_expected_passes integer;v_mapper_articles integer;v_critic_articles integer;v_adjudicator_articles integer;v_unknown integer;v_mismatch integer:=0;v_set record;begin
  select * into j from public.source_page_article_inventory_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'inventory_v1_lease_invalid';end if;
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed' and freeze_receipt_id=j.freeze_receipt_id) then raise exception 'inventory_v1_freeze_stale';end if;
  select * into v_set from public.inventory_page_article_set_proof_v1(j.page_identity_source_image_id);
  if v_set.article_count<>j.existing_article_count or v_set.article_set_fingerprint<>j.page_article_set_fingerprint then raise exception 'inventory_v1_page_article_set_stale';end if;
  v_expected_passes:=case when j.requires_third_pass then 3 else 2 end;
  select count(*)::integer into v_passes from public.source_page_article_inventory_pass_runs_v1 where job_id=j.id;
  if v_passes<>v_expected_passes then raise exception 'inventory_v1_pass_receipts_incomplete';end if;
  select count(*)::integer into v_mapper_articles from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article';
  select count(*)::integer into v_critic_articles from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='critic' and group_kind='article';
  if v_mapper_articles<>v_critic_articles then v_mismatch:=v_mismatch+1;end if;
  if exists((select group_fingerprint,coalesce(mapped_article_id::text,'') mapped from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article' except select group_fingerprint,coalesce(mapped_article_id::text,'') from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='critic' and group_kind='article') union all (select group_fingerprint,coalesce(mapped_article_id::text,'') from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='critic' and group_kind='article' except select group_fingerprint,coalesce(mapped_article_id::text,'') from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article')) then v_mismatch:=v_mismatch+1;end if;
  if j.requires_third_pass then
    select count(*)::integer into v_adjudicator_articles from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='adjudicator' and group_kind='article';
    if v_adjudicator_articles<>v_mapper_articles or exists((select group_fingerprint,coalesce(mapped_article_id::text,'') mapped from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article' except select group_fingerprint,coalesce(mapped_article_id::text,'') from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='adjudicator' and group_kind='article') union all (select group_fingerprint,coalesce(mapped_article_id::text,'') from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='adjudicator' and group_kind='article' except select group_fingerprint,coalesce(mapped_article_id::text,'') from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article')) then v_mismatch:=v_mismatch+1;end if;
  end if;
  if v_mismatch>0 then update public.source_page_article_inventory_jobs_v1 set status='needs_review',lease_token=null,lease_expires_at=null,error_message='independent article inventories disagree',updated_at=now() where id=j.id;return jsonb_build_object('status','needs_review','mapper_articles',v_mapper_articles,'critic_articles',v_critic_articles);end if;
  select count(*)::integer into v_unknown from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article' and mapped_article_id is null;
  if v_unknown>0 then update public.source_page_article_inventory_jobs_v1 set status='discovery_required',lease_token=null,lease_expires_at=null,error_message=format('%s previously unknown article groups discovered',v_unknown),updated_at=now(),finished_at=now() where id=j.id;return jsonb_build_object('status','discovery_required','unknown_article_groups',v_unknown,'inventory_article_count',v_mapper_articles);end if;
  if v_mapper_articles<>j.existing_article_count then update public.source_page_article_inventory_jobs_v1 set status='needs_review',lease_token=null,lease_expires_at=null,error_message=format('inventory count %s differs from frozen article count %s',v_mapper_articles,j.existing_article_count),updated_at=now() where id=j.id;return jsonb_build_object('status','needs_review','inventory_article_count',v_mapper_articles,'frozen_article_count',j.existing_article_count);end if;
  if (select count(distinct mapped_article_id) from public.source_page_article_inventory_groups_v1 where job_id=j.id and pass_kind='mapper' and group_kind='article')<>j.existing_article_count then raise exception 'inventory_v1_mapped_article_set_not_bijective';end if;
  update public.source_page_article_inventory_jobs_v1 set status='completed',lease_token=null,lease_expires_at=null,error_message=null,updated_at=now(),finished_at=now() where id=j.id;
  return jsonb_build_object('status','completed','inventory_article_count',v_mapper_articles,'third_pass',j.requires_third_pass);
end
$$;
revoke all on function public.finalize_source_page_article_inventory_job_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.finalize_source_page_article_inventory_job_v1(uuid,uuid) to service_role;

create or replace view public.source_page_article_inventory_gate_v1
with (security_invoker=true)
as
with fg as (select freeze_receipt_id from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed'), expected as (select count(*)::integer pages from public.source_page_inventory_capture_v1), s as (
 select count(*)::integer jobs,count(*) filter(where status='completed')::integer completed,count(*) filter(where status='discovery_required')::integer discovery_required,count(*) filter(where status='needs_review')::integer needs_review,count(*) filter(where status='failed')::integer failed
 from public.source_page_article_inventory_jobs_v1 j join fg on fg.freeze_receipt_id=j.freeze_receipt_id)
select expected.pages,s.jobs,s.completed,s.discovery_required,s.needs_review,s.failed,
 case when s.discovery_required>0 then 'discovery_required' when s.needs_review>0 or s.failed>0 then 'failed' when s.jobs<>expected.pages or s.completed<>expected.pages then 'pending' else 'passed' end as inventory_gate
from expected cross join s;
revoke all on public.source_page_article_inventory_gate_v1 from public,anon,authenticated;
grant select on public.source_page_article_inventory_gate_v1 to service_role;

create or replace function public.claim_source_page_partition_job_v5(p_lease_seconds integer default 420)
returns setof public.source_page_partition_jobs_v3
language plpgsql security definer
set search_path=pg_catalog,public
as $$begin if not exists(select 1 from public.source_page_article_inventory_gate_v1 where inventory_gate='passed') then raise exception 'partition_v5_article_inventory_not_passed';end if;return query select * from public.claim_source_page_partition_job_v4(p_lease_seconds);end$$;
revoke all on function public.claim_source_page_partition_job_v5(integer) from public,anon,authenticated;
grant execute on function public.claim_source_page_partition_job_v5(integer) to service_role;
revoke execute on function public.claim_source_page_partition_job_v4(integer) from service_role;
revoke execute on function public.claim_source_page_partition_job_v3(integer) from service_role;
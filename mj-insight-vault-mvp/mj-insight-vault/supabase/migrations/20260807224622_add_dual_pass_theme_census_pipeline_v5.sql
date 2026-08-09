create table if not exists public.theme_census_pass_runs_v5 (
  id uuid primary key default gen_random_uuid(),
  census_batch_id uuid not null references public.theme_census_batches_v4(id) on delete cascade,
  analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  pass_kind text not null check (pass_kind in ('mapper','critic')),
  model text not null check (length(btrim(model))>=2),
  provider_response_id text not null unique check (length(btrim(provider_response_id))>=6),
  prompt_sha256 text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check (response_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_set_fingerprint text not null check (candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),
  batch_input_fingerprint text not null check (batch_input_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(census_batch_id,pass_kind)
);

create table if not exists public.theme_census_stage_v5 (
  id uuid primary key default gen_random_uuid(),
  census_batch_id uuid not null references public.theme_census_batches_v4(id) on delete cascade,
  analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  pass_kind text not null check (pass_kind in ('mapper','critic')),
  candidate_id uuid not null references public.theme_candidates_v4(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete restrict,
  relation text not null check (relation in ('support','counter','related_not_supporting','none')),
  subject text check (subject in ('consumer','company','market','expert','regulator','worker','mixed','unclear')),
  measurement text check (measurement in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')),
  source_region_anchor text,
  source_block_index integer,
  source_block_sha256 text,
  source_region_sha256 text not null check (source_region_sha256 ~ '^[0-9a-f]{64}$'),
  rationale text not null check (length(btrim(rationale))>=6),
  confidence numeric not null check (confidence between 0 and 1),
  created_at timestamptz not null default now(),
  unique(census_batch_id,pass_kind,candidate_id,article_id),
  check (
    (relation='none' and coalesce(btrim(source_region_anchor),'')='' and source_block_index is null and source_block_sha256 is null and subject is null and measurement is null)
    or
    (relation<>'none' and length(btrim(coalesce(source_region_anchor,'')))>=6 and source_block_index is not null and source_block_sha256 ~ '^[0-9a-f]{64}$' and subject is not null and measurement is not null)
  )
);

alter table public.theme_census_pass_runs_v5 enable row level security;
alter table public.theme_census_stage_v5 enable row level security;
revoke all on public.theme_census_pass_runs_v5 from public,anon,authenticated,service_role;
revoke all on public.theme_census_stage_v5 from public,anon,authenticated,service_role;

create or replace function public.theme_census_batch_input_fingerprint_v5(p_batch_id uuid)
returns text
language sql
stable security definer
set search_path=pg_catalog,public,extensions
as $$
with b as (
  select b.*,a.candidate_set_fingerprint as current_candidate_fingerprint
  from public.theme_census_batches_v4 b
  join public.theme_analysis_runs_v4 a on a.id=b.analysis_run_id
  where b.id=p_batch_id
), items as (
  select u.article_id,g.source_region_id,g.source_region_sha256,g.current_source_raw_ocr_sha256
  from b cross join lateral unnest(b.article_ids) u(article_id)
  join public.formal_source_grounded_articles_v4 g on g.article_id=u.article_id
), payload as (
  select coalesce(string_agg(jsonb_build_array(article_id::text,source_region_id::text,source_region_sha256,current_source_raw_ocr_sha256)::text,'|' order by article_id::text),'') s from items
)
select encode(extensions.digest(convert_to(
  coalesce((select candidate_set_fingerprint from b),'')||E'\n--ARTICLES--\n'||(select s from payload),
  'UTF8'),'sha256'),'hex');
$$;

create or replace function public.validate_theme_census_stage_v5()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare b public.theme_census_batches_v4%rowtype; g public.formal_source_grounded_articles_v4%rowtype;begin
  select * into b from public.theme_census_batches_v4 where id=new.census_batch_id;
  if not found or b.analysis_run_id<>new.analysis_run_id then raise exception 'census_v5_batch_run_mismatch'; end if;
  if not new.article_id=any(b.article_ids) then raise exception 'census_v5_article_not_in_batch'; end if;
  if not exists(select 1 from public.theme_candidates_v4 c where c.id=new.candidate_id and c.analysis_run_id=new.analysis_run_id) then raise exception 'census_v5_candidate_not_in_run'; end if;
  select * into g from public.formal_source_grounded_articles_v4 where article_id=new.article_id;
  if not found or g.source_region_sha256<>new.source_region_sha256 then raise exception 'census_v5_source_region_stale'; end if;
  if new.relation='none' then return new; end if;
  if not exists(
    select 1 from public.unique_source_block_for_anchor_v4(new.article_id,g.source_region_id,new.source_region_anchor) x
    where x.block_index=new.source_block_index and x.source_block_sha256=new.source_block_sha256
  ) then raise exception 'census_v5_anchor_not_unique_in_source_block'; end if;
  return new;
end $$;

drop trigger if exists trg_validate_theme_census_stage_v5 on public.theme_census_stage_v5;
create trigger trg_validate_theme_census_stage_v5 before insert or update on public.theme_census_stage_v5 for each row execute function public.validate_theme_census_stage_v5();

create or replace function public.enqueue_theme_census_batches_v5(p_analysis_run_id uuid,p_batch_size integer default 20)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare a public.theme_analysis_runs_v4%rowtype;v_count integer;v_batches integer;begin
  select * into a from public.theme_analysis_runs_v4 where id=p_analysis_run_id for update;
  if not found or a.candidate_set_locked_at is null then raise exception 'census_v5_candidate_set_not_locked'; end if;
  if not public.full_corpus_run_integrity_v5(a.scan_run_id) then raise exception 'census_v5_review_run_invalid'; end if;
  if public.theme_candidate_set_fingerprint_v4(a.id)<>a.candidate_set_fingerprint then raise exception 'census_v5_candidate_set_stale'; end if;
  if exists(select 1 from public.theme_census_batches_v4 where analysis_run_id=a.id) then
    select count(*)::integer into v_batches from public.theme_census_batches_v4 where analysis_run_id=a.id;
    return jsonb_build_object('status','already_enqueued','batch_count',v_batches);
  end if;
  p_batch_size:=greatest(4,least(coalesce(p_batch_size,20),30));
  with ordered as (
    select r.article_id,row_number() over(order by r.article_id) rn
    from public.full_corpus_article_reviews_v4 r
    where r.run_id=a.scan_run_id and r.review_version='article_review_v5_dual_source_block'
  ), grouped as (
    select ((rn-1)/p_batch_size)::integer+1 batch_index,array_agg(article_id order by article_id) article_ids
    from ordered group by ((rn-1)/p_batch_size)::integer+1
  )
  insert into public.theme_census_batches_v4(analysis_run_id,batch_index,article_ids,article_count,candidate_set_fingerprint,status)
  select a.id,g.batch_index,g.article_ids,cardinality(g.article_ids),a.candidate_set_fingerprint,'queued' from grouped g order by g.batch_index;
  get diagnostics v_batches=row_count;
  select count(*)::integer into v_count from public.full_corpus_article_reviews_v4 r where r.run_id=a.scan_run_id and r.review_version='article_review_v5_dual_source_block';
  if v_count<>a.expected_article_count then raise exception 'census_v5_article_count_stale'; end if;
  update public.theme_analysis_runs_v4 set status='census_queued',census_started_at=coalesce(census_started_at,now()),updated_at=now() where id=a.id;
  return jsonb_build_object('status','enqueued','batch_count',v_batches,'article_count',v_count,'batch_size',p_batch_size);
end $$;

create or replace function public.claim_theme_census_batch_v5(p_lease_seconds integer default 420)
returns setof public.theme_census_batches_v4
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();begin
  select b.id into v_id
  from public.theme_census_batches_v4 b join public.theme_analysis_runs_v4 a on a.id=b.analysis_run_id
  where (b.status='queued' or (b.status='running' and (b.lease_expires_at is null or b.lease_expires_at<now())))
    and b.attempt_count<4 and (b.next_retry_at is null or b.next_retry_at<=now())
    and a.candidate_set_locked_at is not null and a.candidate_set_fingerprint=b.candidate_set_fingerprint
    and public.full_corpus_run_integrity_v5(a.scan_run_id)
  order by b.created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.theme_census_batches_v4 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(600,coalesce(p_lease_seconds,420)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),last_error_class=null,error_message=null where id=v_id;
  return query select * from public.theme_census_batches_v4 where id=v_id;
end $$;

create or replace function public.replace_theme_census_pass_v5(
  p_batch_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_cells jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare b public.theme_census_batches_v4%rowtype;a public.theme_analysis_runs_v4%rowtype;v_expected integer;v_inserted integer;v_input_fp text;begin
  if p_pass_kind not in ('mapper','critic') then raise exception 'census_v5_pass_kind_invalid'; end if;
  select * into b from public.theme_census_batches_v4 where id=p_batch_id for update;
  if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token or b.lease_expires_at<now() then raise exception 'census_v5_lease_invalid'; end if;
  select * into a from public.theme_analysis_runs_v4 where id=b.analysis_run_id;
  if a.candidate_set_fingerprint<>b.candidate_set_fingerprint or public.theme_candidate_set_fingerprint_v4(a.id)<>a.candidate_set_fingerprint then raise exception 'census_v5_candidate_set_stale'; end if;
  if not public.full_corpus_run_integrity_v5(a.scan_run_id) then raise exception 'census_v5_review_run_invalid'; end if;
  v_expected:=b.article_count*(select count(*) from public.theme_candidates_v4 where analysis_run_id=a.id);
  if v_expected<=0 or jsonb_typeof(p_cells)<>'array' or jsonb_array_length(p_cells)<>v_expected then raise exception 'census_v5_cell_count_mismatch'; end if;
  v_input_fp:=public.theme_census_batch_input_fingerprint_v5(b.id);
  delete from public.theme_census_stage_v5 where census_batch_id=b.id and pass_kind=p_pass_kind;
  delete from public.theme_census_pass_runs_v5 where census_batch_id=b.id and pass_kind=p_pass_kind;
  insert into public.theme_census_stage_v5(census_batch_id,analysis_run_id,pass_kind,candidate_id,article_id,relation,subject,measurement,source_region_anchor,source_block_index,source_block_sha256,source_region_sha256,rationale,confidence)
  select b.id,a.id,p_pass_kind,x.candidate_id,x.article_id,x.relation,nullif(x.subject,''),nullif(x.measurement,''),nullif(x.source_region_anchor,''),x.source_block_index,nullif(x.source_block_sha256,''),x.source_region_sha256,x.rationale,x.confidence
  from jsonb_to_recordset(p_cells) x(candidate_id uuid,article_id uuid,relation text,subject text,measurement text,source_region_anchor text,source_block_index integer,source_block_sha256 text,source_region_sha256 text,rationale text,confidence numeric);
  get diagnostics v_inserted=row_count;
  if v_inserted<>v_expected then raise exception 'census_v5_stage_insert_count_mismatch'; end if;
  if (select count(distinct (candidate_id,article_id)) from public.theme_census_stage_v5 where census_batch_id=b.id and pass_kind=p_pass_kind)<>v_expected then raise exception 'census_v5_duplicate_or_missing_cells'; end if;
  insert into public.theme_census_pass_runs_v5(census_batch_id,analysis_run_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,candidate_set_fingerprint,batch_input_fingerprint)
  values(b.id,a.id,p_pass_kind,left(btrim(p_model),200),btrim(p_provider_response_id),p_prompt_sha256,p_response_sha256,a.candidate_set_fingerprint,v_input_fp);
  return jsonb_build_object('status','stored','pass_kind',p_pass_kind,'cell_count',v_inserted,'batch_input_fingerprint',v_input_fp);
end $$;

create or replace function public.finalize_theme_census_batch_v5(p_batch_id uuid,p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare b public.theme_census_batches_v4%rowtype;a public.theme_analysis_runs_v4%rowtype;m public.theme_census_pass_runs_v5%rowtype;c public.theme_census_pass_runs_v5%rowtype;v_expected integer;v_disagree integer;v_inserted integer;v_input_fp text;v_remaining integer;begin
  select * into b from public.theme_census_batches_v4 where id=p_batch_id for update;
  if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token or b.lease_expires_at<now() then raise exception 'census_v5_lease_invalid'; end if;
  select * into a from public.theme_analysis_runs_v4 where id=b.analysis_run_id;
  if not public.full_corpus_run_integrity_v5(a.scan_run_id) or a.candidate_set_fingerprint<>public.theme_candidate_set_fingerprint_v4(a.id) then raise exception 'census_v5_upstream_stale'; end if;
  v_input_fp:=public.theme_census_batch_input_fingerprint_v5(b.id);
  select * into m from public.theme_census_pass_runs_v5 where census_batch_id=b.id and pass_kind='mapper';
  select * into c from public.theme_census_pass_runs_v5 where census_batch_id=b.id and pass_kind='critic';
  if m.id is null or c.id is null or m.model=c.model or m.provider_response_id=c.provider_response_id or m.prompt_sha256=c.prompt_sha256 then raise exception 'census_v5_independent_pass_receipts_required'; end if;
  if m.batch_input_fingerprint<>v_input_fp or c.batch_input_fingerprint<>v_input_fp or m.candidate_set_fingerprint<>a.candidate_set_fingerprint or c.candidate_set_fingerprint<>a.candidate_set_fingerprint then raise exception 'census_v5_pass_input_stale'; end if;
  v_expected:=b.article_count*(select count(*) from public.theme_candidates_v4 where analysis_run_id=a.id);
  if (select count(*) from public.theme_census_stage_v5 where census_batch_id=b.id and pass_kind='mapper')<>v_expected or (select count(*) from public.theme_census_stage_v5 where census_batch_id=b.id and pass_kind='critic')<>v_expected then raise exception 'census_v5_stage_count_mismatch'; end if;
  select count(*)::integer into v_disagree
  from public.theme_census_stage_v5 x join public.theme_census_stage_v5 y
    on y.census_batch_id=x.census_batch_id and y.candidate_id=x.candidate_id and y.article_id=x.article_id and y.pass_kind='critic'
  where x.census_batch_id=b.id and x.pass_kind='mapper'
    and (x.relation<>y.relation or coalesce(x.subject,'')<>coalesce(y.subject,'') or coalesce(x.measurement,'')<>coalesce(y.measurement,''));
  if v_disagree>0 then
    update public.theme_census_batches_v4 set status='needs_review',last_error_class='census_v5_pass_disagreement',error_message=format('disagreement_cells=%s',v_disagree),lease_token=null,lease_expires_at=null,next_retry_at=null,finished_at=now(),updated_at=now() where id=b.id;
    update public.theme_analysis_runs_v4 set status='needs_review',error_message=format('census batch %s has %s mapper/critic disagreements',b.batch_index,v_disagree),updated_at=now() where id=a.id;
    return jsonb_build_object('status','needs_review','disagreement_cells',v_disagree);
  end if;
  delete from public.theme_census_relations_v4 where census_batch_id=b.id;
  insert into public.theme_census_relations_v4(analysis_run_id,census_batch_id,candidate_id,article_id,relation,subject,measurement,clean_body_anchor,source_region_anchor,rationale,confidence,source_clean_body_sha256,source_region_sha256,source_block_index,source_block_sha256)
  select a.id,b.id,x.candidate_id,x.article_id,x.relation,x.subject,x.measurement,'',x.source_region_anchor,x.rationale,least(x.confidence,y.confidence),g.analysis_body_sha256,g.source_region_sha256,x.source_block_index,x.source_block_sha256
  from public.theme_census_stage_v5 x join public.theme_census_stage_v5 y on y.census_batch_id=x.census_batch_id and y.candidate_id=x.candidate_id and y.article_id=x.article_id and y.pass_kind='critic'
  join public.formal_source_grounded_articles_v4 g on g.article_id=x.article_id
  where x.census_batch_id=b.id and x.pass_kind='mapper';
  get diagnostics v_inserted=row_count;
  if v_inserted<>v_expected then raise exception 'census_v5_final_insert_count_mismatch'; end if;
  update public.theme_census_batches_v4 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=b.id;
  select count(*)::integer into v_remaining from public.theme_census_batches_v4 where analysis_run_id=a.id and status<>'completed';
  if v_remaining=0 then update public.theme_analysis_runs_v4 set status='census_completed',census_completed_at=now(),updated_at=now() where id=a.id; end if;
  return jsonb_build_object('status','completed','cell_count',v_inserted,'remaining_batches',v_remaining);
end $$;

create or replace function public.theme_census_integrity_v5(p_analysis_run_id uuid)
returns boolean
language sql
stable security definer
set search_path=pg_catalog,public
as $$
select public.theme_census_integrity_v4(p_analysis_run_id)
  and not exists(
    select 1 from public.theme_census_batches_v4 b
    where b.analysis_run_id=p_analysis_run_id and (
      b.status<>'completed'
      or (select count(*) from public.theme_census_pass_runs_v5 p where p.census_batch_id=b.id)<>2
      or not exists(select 1 from public.theme_census_pass_runs_v5 m join public.theme_census_pass_runs_v5 c on c.census_batch_id=m.census_batch_id and c.pass_kind='critic' where m.census_batch_id=b.id and m.pass_kind='mapper' and m.model<>c.model and m.provider_response_id<>c.provider_response_id and m.prompt_sha256<>c.prompt_sha256 and m.batch_input_fingerprint=public.theme_census_batch_input_fingerprint_v5(b.id) and c.batch_input_fingerprint=m.batch_input_fingerprint)
      or exists(
        select 1 from public.theme_census_stage_v5 x join public.theme_census_stage_v5 y on y.census_batch_id=x.census_batch_id and y.candidate_id=x.candidate_id and y.article_id=x.article_id and y.pass_kind='critic'
        where x.census_batch_id=b.id and x.pass_kind='mapper' and (x.relation<>y.relation or coalesce(x.subject,'')<>coalesce(y.subject,'') or coalesce(x.measurement,'')<>coalesce(y.measurement,''))
      )
    )
  );
$$;

create or replace function public.enforce_theme_analysis_terminal_status_v4()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
begin
  if new.status in ('census_completed','ranked','completed') and (old.status is distinct from new.status or tg_op='INSERT') and not public.theme_census_integrity_v5(new.id) then raise exception using errcode='23514',message='theme_census_v5_integrity_required'; end if;
  if new.status in ('ranked','completed') and coalesce(new.ranking_version,'')='' then raise exception using errcode='23514',message='theme_ranking_version_required'; end if;
  return new;
end $$;

revoke all on public.theme_census_relations_v4 from service_role;
revoke insert,update,delete on public.theme_census_batches_v4 from service_role;
grant select on public.theme_census_batches_v4,public.theme_census_relations_v4 to service_role;

revoke execute on function public.enqueue_theme_census_batches_v5(uuid,integer) from public,anon,authenticated;
revoke execute on function public.claim_theme_census_batch_v5(integer) from public,anon,authenticated;
revoke execute on function public.replace_theme_census_pass_v5(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke execute on function public.finalize_theme_census_batch_v5(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_theme_census_batches_v5(uuid,integer),public.claim_theme_census_batch_v5(integer),public.replace_theme_census_pass_v5(uuid,uuid,text,text,text,text,text,jsonb),public.finalize_theme_census_batch_v5(uuid,uuid) to service_role;
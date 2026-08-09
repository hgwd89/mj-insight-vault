create or replace function public.source_page_article_set_proof_v2(p_source_image_id uuid)
returns table(article_count integer,article_set_fingerprint text)
language sql
stable security definer
set search_path to 'pg_catalog','public','extensions'
as $$
with x as (
  select f.id,a.article_date_normalized,a.analysis_body_clean_sha256,f.headline
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  where f.source_image_id=p_source_image_id
), c as (
  select count(*)::integer n,
         coalesce(string_agg(encode(extensions.digest(convert_to(jsonb_build_array(id::text,coalesce(headline,''),coalesce(article_date_normalized::text,''),coalesce(analysis_body_clean_sha256,''))::text,'UTF8'),'sha256'::text),'hex'),'|' order by id::text),'') payload
  from x
)
select n,encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'::text),'hex') from c;
$$;

create table if not exists public.source_page_partition_jobs_v2 (
  id uuid primary key default gen_random_uuid(),
  source_image_id uuid not null references public.source_images(id) on delete cascade,
  page_index integer not null default 0,
  partition_version text not null default 'source_block_partition_v2',
  source_ocr_json_sha256 text not null,
  source_article_set_fingerprint text not null,
  article_count integer not null,
  block_count integer not null,
  status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed')),
  mapper_model text,
  critic_model text,
  disagreement_count integer not null default 0,
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_class text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(article_count>0),check(block_count>0)
);

create unique index if not exists source_page_partition_jobs_v2_current_uidx
on public.source_page_partition_jobs_v2(source_image_id,page_index,partition_version,source_ocr_json_sha256,source_article_set_fingerprint)
where status in ('queued','running','needs_review','completed');
create index if not exists source_page_partition_jobs_v2_status_idx
on public.source_page_partition_jobs_v2(status,next_retry_at,created_at);

create table if not exists public.source_page_partition_proposals_v2 (
  job_id uuid not null references public.source_page_partition_jobs_v2(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic')),
  source_image_id uuid not null,
  page_index integer not null,
  block_index integer not null,
  assignment_kind text not null check(assignment_kind in ('article','non_article')),
  article_id uuid references public.articles(id) on delete cascade,
  non_article_role text,
  confidence numeric not null check(confidence>=0 and confidence<=1),
  reason text,
  created_at timestamptz not null default now(),
  primary key(job_id,pass_kind,block_index),
  foreign key(source_image_id,page_index,block_index)
    references public.source_ocr_blocks_v1(source_image_id,page_index,block_index) on delete cascade,
  check((assignment_kind='article' and article_id is not null and non_article_role is null)
     or (assignment_kind='non_article' and article_id is null and coalesce(btrim(non_article_role),'')<>''))
);
create index if not exists source_page_partition_proposals_v2_job_pass_idx
on public.source_page_partition_proposals_v2(job_id,pass_kind);

create or replace function public.validate_source_page_partition_proposal_v2()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
declare j public.source_page_partition_jobs_v2%rowtype; v_article_source uuid;begin
  select * into j from public.source_page_partition_jobs_v2 where id=new.job_id;
  if not found then raise exception 'partition_job_missing'; end if;
  if j.status not in ('running','needs_review') then raise exception 'partition_job_not_writable'; end if;
  if new.source_image_id<>j.source_image_id or new.page_index<>j.page_index then raise exception 'partition_proposal_page_mismatch'; end if;
  if new.assignment_kind='article' then
    select source_image_id into v_article_source from public.formal_corpus_articles_v1 where id=new.article_id;
    if v_article_source is null or v_article_source<>new.source_image_id then raise exception 'partition_proposal_article_not_current_formal_page_article'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_validate_source_page_partition_proposal_v2 on public.source_page_partition_proposals_v2;
create trigger trg_validate_source_page_partition_proposal_v2
before insert or update on public.source_page_partition_proposals_v2
for each row execute function public.validate_source_page_partition_proposal_v2();

create or replace function public.enqueue_source_page_partition_jobs_v2()
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $$
declare v_count integer;begin
  with pages as (
    select distinct f.source_image_id,0::integer page_index
    from public.formal_corpus_articles_v1 f
  ), facts as (
    select p.source_image_id,p.page_index,pr.article_count,pr.article_set_fingerprint,
           max(b.source_ocr_json_sha256) source_hash,count(b.*)::integer block_count
    from pages p
    cross join lateral public.source_page_article_set_proof_v2(p.source_image_id) pr
    join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index
    group by p.source_image_id,p.page_index,pr.article_count,pr.article_set_fingerprint
  ), ins as (
    insert into public.source_page_partition_jobs_v2(source_image_id,page_index,source_ocr_json_sha256,source_article_set_fingerprint,article_count,block_count)
    select f.source_image_id,f.page_index,f.source_hash,f.article_set_fingerprint,f.article_count,f.block_count
    from facts f
    where not exists (
      select 1 from public.source_page_partition_jobs_v2 j
      where j.source_image_id=f.source_image_id and j.page_index=f.page_index
        and j.partition_version='source_block_partition_v2'
        and j.source_ocr_json_sha256=f.source_hash
        and j.source_article_set_fingerprint=f.article_set_fingerprint
        and j.status in ('queued','running','needs_review','completed')
    ) returning 1
  ) select count(*)::integer into v_count from ins;
  return v_count;
end;
$$;

create or replace function public.claim_source_page_partition_job_v2(p_lease_seconds integer default 240)
returns setof public.source_page_partition_jobs_v2
language plpgsql
security definer
set search_path to 'pg_catalog','public'
as $$
declare v_id uuid; v_token uuid:=gen_random_uuid();begin
  select id into v_id
  from public.source_page_partition_jobs_v2
  where status in ('queued','running','needs_review')
    and (next_retry_at is null or next_retry_at<=now())
    and (status<>'running' or lease_expires_at is null or lease_expires_at<now())
  order by case status when 'needs_review' then 0 else 1 end,created_at
  for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.source_page_partition_jobs_v2
  set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(60,p_lease_seconds)),
      attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null
  where id=v_id;
  return query select * from public.source_page_partition_jobs_v2 where id=v_id;
end;
$$;

create or replace function public.finalize_source_page_partition_job_v2(p_job_id uuid,p_lease_token uuid,p_mapper_model text,p_critic_model text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $$
declare
  j public.source_page_partition_jobs_v2%rowtype;
  v_current_hash text; v_current_articles integer; v_current_article_fp text; v_current_blocks integer;
  v_mapper_count integer; v_critic_count integer; v_low_conf integer; v_disagree integer; v_missing_article integer; v_weak_headline integer;
begin
  select * into j from public.source_page_partition_jobs_v2 where id=p_job_id for update;
  if not found then raise exception 'partition_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'partition_job_lease_invalid'; end if;

  select max(source_ocr_json_sha256),count(*)::integer into v_current_hash,v_current_blocks
  from public.source_ocr_blocks_v1 where source_image_id=j.source_image_id and page_index=j.page_index;
  select article_count,article_set_fingerprint into v_current_articles,v_current_article_fp
  from public.source_page_article_set_proof_v2(j.source_image_id);
  if v_current_hash is distinct from j.source_ocr_json_sha256 or v_current_blocks<>j.block_count
     or v_current_articles<>j.article_count or v_current_article_fp<>j.source_article_set_fingerprint then
    update public.source_page_partition_jobs_v2 set status='failed',last_error_class='stale_input',error_message='source_page_partition_job_input_changed',finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
    return jsonb_build_object('status','failed','reason','stale_input');
  end if;

  select count(*) filter(where pass_kind='mapper')::integer,count(*) filter(where pass_kind='critic')::integer,
         count(*) filter(where confidence<0.80)::integer
    into v_mapper_count,v_critic_count,v_low_conf
  from public.source_page_partition_proposals_v2 where job_id=j.id;

  select count(*)::integer into v_disagree
  from public.source_page_partition_proposals_v2 m
  join public.source_page_partition_proposals_v2 c on c.job_id=m.job_id and c.block_index=m.block_index and c.pass_kind='critic'
  where m.job_id=j.id and m.pass_kind='mapper'
    and (m.assignment_kind<>c.assignment_kind or m.article_id is distinct from c.article_id);

  select count(*)::integer into v_missing_article
  from public.formal_corpus_articles_v1 f
  where f.source_image_id=j.source_image_id
    and not exists(select 1 from public.source_page_partition_proposals_v2 p where p.job_id=j.id and p.pass_kind='mapper' and p.assignment_kind='article' and p.article_id=f.id)
    or f.source_image_id=j.source_image_id
    and not exists(select 1 from public.source_page_partition_proposals_v2 p where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=f.id);

  select count(*)::integer into v_weak_headline
  from public.formal_corpus_articles_v1 f
  where f.source_image_id=j.source_image_id
    and not exists(
      select 1 from public.source_page_partition_proposals_v2 p
      join public.source_ocr_blocks_v1 b on b.source_image_id=p.source_image_id and b.page_index=p.page_index and b.block_index=p.block_index
      where p.job_id=j.id and p.pass_kind='critic' and p.assignment_kind='article' and p.article_id=f.id
        and similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))>=0.20
    );

  if v_mapper_count<>j.block_count or v_critic_count<>j.block_count or v_low_conf>0 or v_disagree>0 or v_missing_article>0 or v_weak_headline>0 then
    update public.source_page_partition_jobs_v2
    set status='needs_review',mapper_model=p_mapper_model,critic_model=p_critic_model,disagreement_count=v_disagree,
        last_error_class='partition_quality',
        error_message=format('mapper=%s critic=%s expected=%s low_conf=%s disagreements=%s missing_articles=%s weak_headlines=%s',v_mapper_count,v_critic_count,j.block_count,v_low_conf,v_disagree,v_missing_article,v_weak_headline),
        lease_token=null,lease_expires_at=null,updated_at=now()
    where id=j.id;
    return jsonb_build_object('status','needs_review','mapper_count',v_mapper_count,'critic_count',v_critic_count,'expected_block_count',j.block_count,'low_confidence',v_low_conf,'disagreements',v_disagree,'missing_articles',v_missing_article,'weak_headlines',v_weak_headline);
  end if;

  delete from public.source_ocr_block_assignments_v2 where source_image_id=j.source_image_id and page_index=j.page_index and assignment_version='source_block_partition_v2';
  insert into public.source_ocr_block_assignments_v2(source_image_id,page_index,block_index,assignment_version,assignment_kind,article_id,non_article_role,assignment_confidence,assignment_reason,source_ocr_json_sha256)
  select c.source_image_id,c.page_index,c.block_index,'source_block_partition_v2',c.assignment_kind,c.article_id,
         case when c.assignment_kind='non_article' then c.non_article_role else null end,
         least(m.confidence,c.confidence),concat_ws(' | ','mapper: '||coalesce(m.reason,''),'critic: '||coalesce(c.reason,'')),j.source_ocr_json_sha256
  from public.source_page_partition_proposals_v2 c
  join public.source_page_partition_proposals_v2 m on m.job_id=c.job_id and m.block_index=c.block_index and m.pass_kind='mapper'
  where c.job_id=j.id and c.pass_kind='critic';

  insert into public.article_source_regions(article_id,source_image_id,region_version,page_index,x_min,y_min,x_max,y_max,mapping_method,mapping_confidence,headline_anchor,headline_similarity,source_region_text,source_region_sha256,source_image_raw_ocr_sha256,source_clean_body_sha256,quality_status,quality_reason,model,block_partition_version,assigned_block_count,partition_fingerprint,updated_at)
  select f.id,j.source_image_id,'source_region_v2_blockset',j.page_index,
         min(b.x_min),min(b.y_min),max(b.x_max),max(b.y_max),'dual_pass_block_partition_v2',min(a.assignment_confidence),
         (array_agg(b.block_text order by similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text)) desc,b.block_index))[1],
         max(similarity(public.normalize_article_headline_v1(f.headline),public.normalize_article_headline_v1(b.block_text))),
         string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index),
         encode(extensions.digest(convert_to(string_agg(b.block_text,E'\n\n' order by a.page_index,a.block_index),'UTF8'),'sha256'::text),'hex'),
         v.source_raw_ocr_sha256,v.analysis_body_sha256,'passed','dual_pass_mapper_critic_agreement','mapper='||coalesce(p_mapper_model,'')||';critic='||coalesce(p_critic_model,''),
         'source_block_partition_v2',count(*)::integer,
         encode(extensions.digest(convert_to(string_agg(a.page_index::text||':'||a.block_index::text||':'||a.source_ocr_json_sha256,E'|' order by a.page_index,a.block_index),'UTF8'),'sha256'::text),'hex'),now()
  from public.formal_corpus_articles_v1 f
  join public.formal_article_analysis_text_v2 v on v.article_id=f.id
  join public.source_ocr_block_assignments_v2 a on a.article_id=f.id and a.source_image_id=j.source_image_id and a.page_index=j.page_index and a.assignment_version='source_block_partition_v2' and a.assignment_kind='article'
  join public.source_ocr_blocks_v1 b using(source_image_id,page_index,block_index)
  where f.source_image_id=j.source_image_id
  group by f.id,v.source_raw_ocr_sha256,v.analysis_body_sha256
  on conflict(article_id,region_version) do update set
    source_image_id=excluded.source_image_id,page_index=excluded.page_index,x_min=excluded.x_min,y_min=excluded.y_min,x_max=excluded.x_max,y_max=excluded.y_max,
    mapping_method=excluded.mapping_method,mapping_confidence=excluded.mapping_confidence,headline_anchor=excluded.headline_anchor,headline_similarity=excluded.headline_similarity,
    source_region_text=excluded.source_region_text,source_region_sha256=excluded.source_region_sha256,source_image_raw_ocr_sha256=excluded.source_image_raw_ocr_sha256,
    source_clean_body_sha256=excluded.source_clean_body_sha256,quality_status=excluded.quality_status,quality_reason=excluded.quality_reason,model=excluded.model,
    block_partition_version=excluded.block_partition_version,assigned_block_count=excluded.assigned_block_count,partition_fingerprint=excluded.partition_fingerprint,updated_at=now();

  update public.source_page_partition_jobs_v2
  set status='completed',mapper_model=p_mapper_model,critic_model=p_critic_model,disagreement_count=0,error_message=null,last_error_class=null,finished_at=now(),lease_token=null,lease_expires_at=null,updated_at=now()
  where id=j.id;
  return jsonb_build_object('status','completed','block_count',j.block_count,'article_count',j.article_count);
end;
$$;
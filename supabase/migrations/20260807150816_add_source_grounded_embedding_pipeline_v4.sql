create view public.formal_article_embedding_input_v4 as
with block_text as (
  select b.article_id,
         string_agg(regexp_replace(btrim(b.block_text),'\s+',' ','g'),E'\n---\n' order by b.x_min,b.y_min,b.block_index) embedding_input_text
  from public.formal_source_grounded_article_blocks_v4 b
  group by b.article_id
)
select g.article_id,g.source_region_id,g.partition_job_id,g.page_identity_source_image_id,g.evidence_source_image_id,
       g.source_region_sha256,g.current_source_raw_ocr_sha256,g.analysis_body_sha256,
       fg.freeze_receipt_id,
       bt.embedding_input_text,
       encode(extensions.digest(convert_to(bt.embedding_input_text,'UTF8'),'sha256'),'hex') embedding_input_sha256
from public.formal_source_grounded_articles_v4 g
join block_text bt on bt.article_id=g.article_id
join public.formal_corpus_freeze_gate_v1 fg on fg.freeze_gate='passed'
where coalesce(bt.embedding_input_text,'')<>'';

create table public.article_embeddings_v4 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  source_region_id uuid not null references public.article_source_regions(id),
  source_partition_job_id uuid not null references public.source_page_partition_jobs_v3(id),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  source_region_sha256 text not null check(source_region_sha256 ~ '^[0-9a-f]{64}$'),
  source_ocr_sha256 text not null check(source_ocr_sha256 ~ '^[0-9a-f]{64}$'),
  embedding_input_text text not null,
  embedding_input_sha256 text not null check(embedding_input_sha256 ~ '^[0-9a-f]{64}$'),
  embedding_vector public.vector(1536) not null,
  embedding_model text not null,
  embedding_version text not null default 'article_semantic_source_region_v4',
  quality_status text not null default 'passed' check(quality_status in ('passed','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256)
);
create index article_embeddings_v4_article_idx on public.article_embeddings_v4(article_id);
create index article_embeddings_v4_vector_idx on public.article_embeddings_v4 using hnsw (embedding_vector vector_cosine_ops);

create table public.article_embedding_jobs_v4 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  source_region_id uuid not null references public.article_source_regions(id),
  source_partition_job_id uuid not null references public.source_page_partition_jobs_v3(id),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  source_region_sha256 text not null,
  source_ocr_sha256 text not null,
  embedding_input_text text not null,
  embedding_input_sha256 text not null,
  embedding_version text not null default 'article_semantic_source_region_v4',
  status text not null default 'queued' check(status in ('queued','running','completed','failed')),
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
  unique(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256)
);
create index article_embedding_jobs_v4_status_idx on public.article_embedding_jobs_v4(status,next_retry_at,created_at);

create function public.enqueue_article_embedding_jobs_v4()
returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;begin
  if (select source_region_gate from public.article_source_region_gate_v4)<>'passed' then raise exception 'embedding_v4_source_region_gate_not_passed'; end if;
  if (select freeze_gate from public.formal_corpus_freeze_gate_v1)<>'passed' then raise exception 'embedding_v4_freeze_gate_not_passed'; end if;
  with ins as (
    insert into public.article_embedding_jobs_v4(
      article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,embedding_input_text,embedding_input_sha256
    )
    select i.article_id,i.source_region_id,i.partition_job_id,i.freeze_receipt_id,i.source_region_sha256,i.current_source_raw_ocr_sha256,i.embedding_input_text,i.embedding_input_sha256
    from public.formal_article_embedding_input_v4 i
    on conflict do nothing returning 1
  ) select count(*)::integer into v_count from ins;
  return v_count;
end $$;

create function public.claim_article_embedding_jobs_v4(p_limit integer default 64,p_lease_seconds integer default 300)
returns setof public.article_embedding_jobs_v4
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_token uuid:=gen_random_uuid();begin
  return query
  with picked as (
    select id from public.article_embedding_jobs_v4
    where (status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at<now())))
      and attempt_count<4
      and (next_retry_at is null or next_retry_at<=now())
    order by created_at
    for update skip locked
    limit greatest(1,least(128,coalesce(p_limit,64)))
  ), upd as (
    update public.article_embedding_jobs_v4 j
    set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(120,least(600,coalesce(p_lease_seconds,300)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null
    from picked p where j.id=p.id returning j.*
  ) select * from upd;
end $$;

create function public.complete_article_embedding_job_v4(p_job_id uuid,p_lease_token uuid,p_embedding_vector_text text,p_embedding_model text)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  j public.article_embedding_jobs_v4%rowtype;
  i public.formal_article_embedding_input_v4%rowtype;
  v public.vector(1536);
begin
  select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
  if not found then raise exception 'embedding_v4_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'embedding_v4_job_lease_invalid'; end if;
  select * into i from public.formal_article_embedding_input_v4 where article_id=j.article_id;
  if not found then raise exception 'embedding_v4_input_not_current'; end if;
  if i.freeze_receipt_id<>j.freeze_receipt_id or i.source_region_id<>j.source_region_id or i.partition_job_id<>j.source_partition_job_id or i.source_region_sha256<>j.source_region_sha256 or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256 or i.embedding_input_sha256<>j.embedding_input_sha256 or i.embedding_input_text<>j.embedding_input_text then raise exception 'embedding_v4_input_stale'; end if;
  if coalesce(btrim(p_embedding_model),'')='' then raise exception 'embedding_v4_model_required'; end if;
  begin
    v:=p_embedding_vector_text::public.vector(1536);
  exception when others then
    raise exception 'embedding_v4_vector_invalid';
  end;
  if v is null then raise exception 'embedding_v4_vector_missing'; end if;

  insert into public.article_embeddings_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,embedding_input_text,embedding_input_sha256,embedding_vector,embedding_model,embedding_version,quality_status,updated_at)
  values(j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,j.embedding_input_text,j.embedding_input_sha256,v,left(p_embedding_model,200),j.embedding_version,'passed',now())
  on conflict(article_id,freeze_receipt_id,embedding_version,embedding_input_sha256)
  do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,embedding_input_text=excluded.embedding_input_text,embedding_vector=excluded.embedding_vector,embedding_model=excluded.embedding_model,quality_status='passed',updated_at=now();

  update public.article_embedding_jobs_v4 set status='completed',lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','job_id',j.id,'article_id',j.article_id);
end $$;

create function public.fail_article_embedding_job_v4(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.article_embedding_jobs_v4%rowtype;v_retry boolean;v_delay integer;begin
  select * into j from public.article_embedding_jobs_v4 where id=p_job_id for update;
  if not found then raise exception 'embedding_v4_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'embedding_v4_job_lease_invalid'; end if;
  v_retry:=coalesce(p_retryable,true) and j.attempt_count<4;
  v_delay:=least(600,30*(2^greatest(0,j.attempt_count-1))::integer);
  update public.article_embedding_jobs_v4 set status=case when v_retry then 'queued' else 'failed' end,last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),error_message=left(coalesce(p_error_message,'embedding worker failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,finished_at=case when v_retry then null else now() end,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',j.attempt_count);
end $$;

create view public.formal_article_embeddings_v4 as
select e.*
from public.article_embeddings_v4 e
join public.formal_article_embedding_input_v4 i on i.article_id=e.article_id
where e.embedding_version='article_semantic_source_region_v4'
  and e.quality_status='passed'
  and e.freeze_receipt_id=i.freeze_receipt_id
  and e.source_region_id=i.source_region_id
  and e.source_partition_job_id=i.partition_job_id
  and e.source_region_sha256=i.source_region_sha256
  and e.source_ocr_sha256=i.current_source_raw_ocr_sha256
  and e.embedding_input_sha256=i.embedding_input_sha256
  and e.embedding_input_text=i.embedding_input_text;

create view public.article_embedding_quality_gate_v4 as
with i as (select count(*)::integer formal_article_count from public.formal_article_embedding_input_v4),
e as (select count(*)::integer strict_embedding_count from public.formal_article_embeddings_v4),
j as (select count(*)::integer total_jobs,count(*) filter(where status='queued')::integer queued_jobs,count(*) filter(where status='running')::integer running_jobs,count(*) filter(where status='failed')::integer failed_jobs,count(*) filter(where status='completed')::integer completed_jobs from public.article_embedding_jobs_v4)
select i.formal_article_count,e.strict_embedding_count,j.total_jobs,j.queued_jobs,j.running_jobs,j.failed_jobs,j.completed_jobs,
       case when i.formal_article_count>0 and e.strict_embedding_count=i.formal_article_count then 'passed' else 'failed' end embedding_gate,
       case when i.formal_article_count=0 then 'source_grounded_articles_required' when e.strict_embedding_count<>i.formal_article_count then 'source_grounded_embedding_rebuild_required' else 'passed' end gate_reason
from i cross join e cross join j;

alter table public.article_embeddings_v4 enable row level security;
alter table public.article_embedding_jobs_v4 enable row level security;
revoke all on table public.article_embeddings_v4 from anon,authenticated;
revoke all on table public.article_embedding_jobs_v4 from anon,authenticated;
revoke all on table public.formal_article_embedding_input_v4 from anon,authenticated;
revoke all on table public.formal_article_embeddings_v4 from anon,authenticated;
revoke all on table public.article_embedding_quality_gate_v4 from anon,authenticated;
grant all on table public.article_embeddings_v4 to service_role;
grant all on table public.article_embedding_jobs_v4 to service_role;
grant select on table public.formal_article_embedding_input_v4 to service_role;
grant select on table public.formal_article_embeddings_v4 to service_role;
grant select on table public.article_embedding_quality_gate_v4 to service_role;
revoke execute on function public.enqueue_article_embedding_jobs_v4() from public,anon,authenticated;
revoke execute on function public.claim_article_embedding_jobs_v4(integer,integer) from public,anon,authenticated;
revoke execute on function public.complete_article_embedding_job_v4(uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.fail_article_embedding_job_v4(uuid,uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.enqueue_article_embedding_jobs_v4() to service_role;
grant execute on function public.claim_article_embedding_jobs_v4(integer,integer) to service_role;
grant execute on function public.complete_article_embedding_job_v4(uuid,uuid,text,text) to service_role;
grant execute on function public.fail_article_embedding_job_v4(uuid,uuid,text,boolean,text) to service_role;
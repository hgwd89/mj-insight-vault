create table public.source_page_partition_jobs_v3 (
  id uuid primary key default gen_random_uuid(),
  page_identity_source_image_id uuid not null references public.source_images(id),
  evidence_source_image_id uuid not null references public.source_images(id),
  page_index integer not null default 0,
  partition_version text not null default 'source_block_partition_v3_page_identity',
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  source_ocr_json_sha256 text not null,
  page_article_set_fingerprint text not null,
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
  unique(evidence_source_image_id,page_index,partition_version,freeze_receipt_id,source_ocr_json_sha256,page_article_set_fingerprint)
);
create index source_page_partition_jobs_v3_status_idx on public.source_page_partition_jobs_v3(status,next_retry_at,created_at);
create index source_page_partition_jobs_v3_identity_idx on public.source_page_partition_jobs_v3(page_identity_source_image_id);

create table public.source_page_partition_proposals_v3 (
  job_id uuid not null references public.source_page_partition_jobs_v3(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('mapper','critic')),
  source_image_id uuid not null,
  page_index integer not null,
  block_index integer not null,
  assignment_kind text not null check(assignment_kind in ('article','non_article')),
  article_id uuid references public.articles(id),
  non_article_role text,
  confidence numeric not null check(confidence>=0 and confidence<=1),
  reason text,
  created_at timestamptz not null default now(),
  primary key(job_id,pass_kind,block_index),
  foreign key(source_image_id,page_index,block_index) references public.source_ocr_blocks_v1(source_image_id,page_index,block_index),
  check((assignment_kind='article' and article_id is not null and non_article_role is null) or (assignment_kind='non_article' and article_id is null and non_article_role is not null))
);

create function public.source_page_identity_article_set_proof_v3(p_page_identity_source_image_id uuid)
returns table(article_count integer,article_set_fingerprint text)
language sql stable security definer set search_path=public,extensions as $$
with x as (
  select f.id,f.source_image_id,f.headline,a.article_date_normalized,a.analysis_body_clean_sha256
  from public.formal_corpus_articles_v1 f
  join public.articles a on a.id=f.id
  join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
  where m.page_identity_source_image_id=p_page_identity_source_image_id
), c as (
  select count(*)::integer n,
         coalesce(string_agg(encode(digest(convert_to(jsonb_build_array(id::text,source_image_id::text,coalesce(headline,''),coalesce(article_date_normalized::text,''),coalesce(analysis_body_clean_sha256,''))::text,'UTF8'),'sha256'),'hex'),'|' order by id::text),'') payload
  from x
)
select n,encode(digest(convert_to(payload,'UTF8'),'sha256'),'hex') from c;
$$;

create function public.validate_source_page_partition_proposal_v3()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare
  j public.source_page_partition_jobs_v3%rowtype;
  v_article_source uuid;
  v_article_page uuid;
  v_capture_page uuid;
begin
  select * into j from public.source_page_partition_jobs_v3 where id=new.job_id;
  if not found then raise exception 'partition_v3_job_missing'; end if;
  if j.status not in ('running','needs_review') then raise exception 'partition_v3_job_not_writable'; end if;
  if new.source_image_id<>j.evidence_source_image_id or new.page_index<>j.page_index then raise exception 'partition_v3_proposal_capture_mismatch'; end if;
  select page_identity_source_image_id into v_capture_page from public.source_page_capture_map_v1 where source_image_id=new.source_image_id;
  if v_capture_page is distinct from j.page_identity_source_image_id then raise exception 'partition_v3_capture_page_identity_mismatch'; end if;
  if new.assignment_kind='article' then
    select f.source_image_id into v_article_source from public.formal_corpus_articles_v1 f where f.id=new.article_id;
    if v_article_source is null then raise exception 'partition_v3_article_not_current_formal'; end if;
    select page_identity_source_image_id into v_article_page from public.source_page_capture_map_v1 where source_image_id=v_article_source;
    if v_article_page is distinct from j.page_identity_source_image_id then raise exception 'partition_v3_article_not_same_page_identity'; end if;
  end if;
  return new;
end $$;
create trigger source_page_partition_proposals_v3_validate
before insert or update on public.source_page_partition_proposals_v3
for each row execute function public.validate_source_page_partition_proposal_v3();

create function public.enqueue_source_page_partition_jobs_v3()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;begin
  if (select freeze_gate from public.formal_corpus_freeze_gate_v1)<>'passed' then raise exception 'partition_v3_freeze_gate_not_passed'; end if;
  with current_freeze as (select freeze_receipt_id from public.formal_corpus_freeze_gate_v1), facts as (
    select pc.page_identity_source_image_id,pc.evidence_source_image_id,0::integer page_index,pc.freeze_receipt_id,
           pr.article_count,pr.article_set_fingerprint,max(b.source_ocr_json_sha256) source_hash,count(b.*)::integer block_count
    from public.source_page_primary_capture_v1 pc
    cross join lateral public.source_page_identity_article_set_proof_v3(pc.page_identity_source_image_id) pr
    join public.source_ocr_blocks_v1 b on b.source_image_id=pc.evidence_source_image_id and b.page_index=0
    join current_freeze cf on cf.freeze_receipt_id=pc.freeze_receipt_id
    group by pc.page_identity_source_image_id,pc.evidence_source_image_id,pc.freeze_receipt_id,pr.article_count,pr.article_set_fingerprint
  ), ins as (
    insert into public.source_page_partition_jobs_v3(page_identity_source_image_id,evidence_source_image_id,page_index,freeze_receipt_id,source_ocr_json_sha256,page_article_set_fingerprint,article_count,block_count)
    select f.page_identity_source_image_id,f.evidence_source_image_id,f.page_index,f.freeze_receipt_id,f.source_hash,f.article_set_fingerprint,f.article_count,f.block_count
    from facts f
    on conflict do nothing returning 1
  ) select count(*)::integer into v_count from ins;
  return v_count;
end $$;

create function public.claim_source_page_partition_job_v3(p_lease_seconds integer default 240)
returns setof public.source_page_partition_jobs_v3 language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid; v_token uuid:=gen_random_uuid();begin
  select id into v_id from public.source_page_partition_jobs_v3
  where status in ('queued','running','needs_review')
    and (next_retry_at is null or next_retry_at<=now())
    and (status<>'running' or lease_expires_at is null or lease_expires_at<now())
  order by case status when 'needs_review' then 0 else 1 end,created_at
  for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.source_page_partition_jobs_v3 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(60,p_lease_seconds)),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null where id=v_id;
  return query select * from public.source_page_partition_jobs_v3 where id=v_id;
end $$;
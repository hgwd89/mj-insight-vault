-- Page-first OCR recovery before formal article inventory.
-- Goal: reread every canonical page image, retain a binary receipt, detect OCR-missing blocks,
-- and only then allow the blind inventory worker to consume the fresh page OCR.

create table if not exists public.source_page_ocr_recovery_jobs_v1 (
  id uuid primary key default gen_random_uuid(),
  page_identity_source_image_id uuid not null,
  source_image_id uuid not null references public.source_images(id) on delete restrict,
  source_ocr_json_sha256 text not null,
  source_storage_etag text not null,
  source_storage_size_bytes bigint not null check (source_storage_size_bytes > 0),
  old_block_count integer not null check (old_block_count > 0),
  recovery_version text not null default 'page_ocr_recovery_v1_fresh_google',
  status text not null default 'queued' check (status in ('queued','running','completed','needs_review','failed')),
  stage text not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_token uuid,
  lease_expires_at timestamptz,
  source_binary_sha256 text,
  fresh_google_response_sha256 text,
  fresh_google_text_sha256 text,
  fresh_block_count integer,
  old_fresh_text_similarity real,
  fresh_old_char_ratio real,
  recovered_candidate_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(page_identity_source_image_id, source_image_id, source_ocr_json_sha256, recovery_version)
);

create index if not exists source_page_ocr_recovery_jobs_v1_status_idx
  on public.source_page_ocr_recovery_jobs_v1(status, lease_expires_at, created_at);

create table if not exists public.source_page_ocr_recovery_fresh_blocks_v1 (
  job_id uuid not null references public.source_page_ocr_recovery_jobs_v1(id) on delete cascade,
  block_index integer not null check (block_index >= 0),
  block_text text not null,
  x_min integer not null,
  y_min integer not null,
  x_max integer not null,
  y_max integer not null,
  ocr_confidence numeric,
  best_old_block_index integer,
  best_iou real,
  candidate_kind text not null check (candidate_kind in ('matched','missing_candidate')),
  fresh_google_response_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key(job_id, block_index),
  check (x_max > x_min and y_max > y_min)
);

create table if not exists public.source_page_ocr_recovery_receipts_v1 (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.source_page_ocr_recovery_jobs_v1(id) on delete restrict,
  page_identity_source_image_id uuid not null,
  source_image_id uuid not null,
  source_ocr_json_sha256 text not null,
  source_binary_sha256 text not null,
  fresh_google_response_sha256 text not null,
  fresh_google_text_sha256 text not null,
  fresh_block_count integer not null check (fresh_block_count > 0),
  old_fresh_text_similarity real not null,
  fresh_old_char_ratio real not null,
  recovered_candidate_count integer not null default 0,
  recovered_ocr_fingerprint text not null unique,
  status text not null check (status='passed'),
  created_at timestamptz not null default now()
);

alter table public.source_page_ocr_recovery_jobs_v1 enable row level security;
alter table public.source_page_ocr_recovery_fresh_blocks_v1 enable row level security;
alter table public.source_page_ocr_recovery_receipts_v1 enable row level security;

revoke all on table public.source_page_ocr_recovery_jobs_v1 from public,anon,authenticated;
revoke all on table public.source_page_ocr_recovery_fresh_blocks_v1 from public,anon,authenticated;
revoke all on table public.source_page_ocr_recovery_receipts_v1 from public,anon,authenticated;
grant select,insert,update,delete on table public.source_page_ocr_recovery_jobs_v1 to service_role;
grant select,insert,update,delete on table public.source_page_ocr_recovery_fresh_blocks_v1 to service_role;
grant select,insert,update,delete on table public.source_page_ocr_recovery_receipts_v1 to service_role;

create or replace function public.enqueue_source_page_ocr_recovery_jobs_v1()
returns integer language plpgsql security definer set search_path='pg_catalog','public' as $$
declare v_count integer;
begin
  insert into public.source_page_ocr_recovery_jobs_v1(
    page_identity_source_image_id,source_image_id,source_ocr_json_sha256,
    source_storage_etag,source_storage_size_bytes,old_block_count
  )
  select c.page_identity_source_image_id,c.inventory_source_image_id,c.source_ocr_json_sha256,
         s.storage_etag,s.storage_size_bytes,c.block_count
  from public.source_page_inventory_capture_v1 c
  join public.source_images s on s.id=c.inventory_source_image_id
  where coalesce(s.storage_path,'')<>'' and coalesce(s.storage_etag,'')<>''
    and s.storage_size_bytes>0 and s.width>0 and s.height>0 and c.block_count>0
  on conflict(page_identity_source_image_id,source_image_id,source_ocr_json_sha256,recovery_version) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.claim_source_page_ocr_recovery_job_v1(p_lease_seconds integer default 300)
returns table(id uuid,page_identity_source_image_id uuid,source_image_id uuid,source_ocr_json_sha256 text,old_block_count integer,lease_token uuid)
language plpgsql security definer set search_path='pg_catalog','public' as $$
declare v_id uuid; v_token uuid:=gen_random_uuid();
begin
  select j.id into v_id from public.source_page_ocr_recovery_jobs_v1 j
  where j.status='queued' or (j.status='running' and j.lease_expires_at<now())
  order by case when j.status='queued' then 0 else 1 end,j.created_at,j.id
  for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.source_page_ocr_recovery_jobs_v1 j
  set status='running',stage='claimed',lease_token=v_token,
      lease_expires_at=now()+make_interval(secs=>greatest(60,least(coalesce(p_lease_seconds,300),900))),
      attempt_count=j.attempt_count+1,updated_at=now(),error_message=null
  where j.id=v_id;
  return query select j.id,j.page_identity_source_image_id,j.source_image_id,j.source_ocr_json_sha256,j.old_block_count,j.lease_token
  from public.source_page_ocr_recovery_jobs_v1 j where j.id=v_id;
end $$;

create or replace function public.record_source_page_ocr_recovery_fresh_v1(
  p_job_id uuid,p_lease_token uuid,p_source_binary_sha256 text,
  p_fresh_google_response_sha256 text,p_fresh_google_text_sha256 text,p_blocks jsonb
)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare j public.source_page_ocr_recovery_jobs_v1%rowtype; s public.source_images%rowtype; v_count integer; v_missing integer;
begin
  select * into j from public.source_page_ocr_recovery_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'page_ocr_recovery_v1_lease_invalid'; end if;
  if coalesce(p_source_binary_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_fresh_google_response_sha256,'') !~ '^[0-9a-f]{64}$' or coalesce(p_fresh_google_text_sha256,'') !~ '^[0-9a-f]{64}$' then raise exception 'page_ocr_recovery_v1_receipt_invalid'; end if;
  if jsonb_typeof(p_blocks)<>'array' or jsonb_array_length(p_blocks)<1 then raise exception 'page_ocr_recovery_v1_blocks_empty'; end if;
  select * into s from public.source_images where id=j.source_image_id;
  delete from public.source_page_ocr_recovery_fresh_blocks_v1 where job_id=j.id;
  insert into public.source_page_ocr_recovery_fresh_blocks_v1(
    job_id,block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,best_old_block_index,best_iou,candidate_kind,fresh_google_response_sha256
  )
  select j.id,(x->>'block_index')::integer,coalesce(x->>'block_text',''),
         (x->>'x_min')::integer,(x->>'y_min')::integer,(x->>'x_max')::integer,(x->>'y_max')::integer,
         nullif(x->>'ocr_confidence','')::numeric,nullif(x->>'best_old_block_index','')::integer,
         nullif(x->>'best_iou','')::real,x->>'candidate_kind',p_fresh_google_response_sha256
  from jsonb_array_elements(p_blocks) x;
  if exists(select 1 from public.source_page_ocr_recovery_fresh_blocks_v1 b where b.job_id=j.id and
     (b.block_text='' or b.x_min<0 or b.y_min<0 or b.x_max>s.width or b.y_max>s.height or b.candidate_kind not in ('matched','missing_candidate'))) then
    raise exception 'page_ocr_recovery_v1_block_invalid';
  end if;
  select count(*)::integer,count(*) filter(where candidate_kind='missing_candidate')::integer into v_count,v_missing
  from public.source_page_ocr_recovery_fresh_blocks_v1 where job_id=j.id;
  update public.source_page_ocr_recovery_jobs_v1
  set source_binary_sha256=p_source_binary_sha256,fresh_google_response_sha256=p_fresh_google_response_sha256,
      fresh_google_text_sha256=p_fresh_google_text_sha256,fresh_block_count=v_count,recovered_candidate_count=v_missing,
      stage='fresh_ocr_recorded',updated_at=now() where id=j.id;
  return jsonb_build_object('stored_blocks',v_count,'missing_candidates',v_missing);
end $$;

create or replace function public.finalize_source_page_ocr_recovery_job_v1(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public','extensions' as $$
declare j public.source_page_ocr_recovery_jobs_v1%rowtype; v_old text; v_fresh text; v_sim real; v_ratio real; v_fp text;
begin
  select * into j from public.source_page_ocr_recovery_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'page_ocr_recovery_v1_lease_invalid'; end if;
  if j.fresh_block_count is null or j.fresh_block_count<1 or j.source_binary_sha256 is null or j.fresh_google_response_sha256 is null then raise exception 'page_ocr_recovery_v1_fresh_ocr_incomplete'; end if;
  select public.normalize_ocr_consensus_text_v2(string_agg(b.block_text,E'\n' order by b.block_index)) into v_old
  from public.source_ocr_blocks_v1 b where b.source_image_id=j.source_image_id and b.page_index=0 and b.source_ocr_json_sha256=j.source_ocr_json_sha256;
  select public.normalize_ocr_consensus_text_v2(string_agg(b.block_text,E'\n' order by b.block_index)) into v_fresh
  from public.source_page_ocr_recovery_fresh_blocks_v1 b where b.job_id=j.id;
  if coalesce(v_old,'')='' or coalesce(v_fresh,'')='' then raise exception 'page_ocr_recovery_v1_text_empty'; end if;
  v_sim:=similarity(v_old,v_fresh);
  v_ratio:=char_length(v_fresh)::real/greatest(1,char_length(v_old));
  update public.source_page_ocr_recovery_jobs_v1 set old_fresh_text_similarity=v_sim,fresh_old_char_ratio=v_ratio,updated_at=now() where id=j.id;
  if v_sim<0.60 or v_ratio<0.65 or v_ratio>1.60 then
    update public.source_page_ocr_recovery_jobs_v1 set status='needs_review',stage='fresh_ocr_sanity_review',lease_token=null,lease_expires_at=null,
      error_message=format('fresh OCR sanity mismatch: similarity=%s char_ratio=%s',v_sim,v_ratio),updated_at=now() where id=j.id;
    return jsonb_build_object('status','needs_review','similarity',v_sim,'char_ratio',v_ratio,'missing_candidates',j.recovered_candidate_count);
  end if;
  v_fp:=encode(digest(convert_to(concat_ws('|','page_ocr_recovery_v1_fresh_google',j.page_identity_source_image_id::text,j.source_image_id::text,
      j.source_ocr_json_sha256,j.source_binary_sha256,j.fresh_google_response_sha256,j.fresh_google_text_sha256,j.fresh_block_count::text,j.recovered_candidate_count::text),'UTF8'),'sha256'),'hex');
  insert into public.source_page_ocr_recovery_receipts_v1(
    job_id,page_identity_source_image_id,source_image_id,source_ocr_json_sha256,source_binary_sha256,fresh_google_response_sha256,
    fresh_google_text_sha256,fresh_block_count,old_fresh_text_similarity,fresh_old_char_ratio,recovered_candidate_count,recovered_ocr_fingerprint,status
  ) values(j.id,j.page_identity_source_image_id,j.source_image_id,j.source_ocr_json_sha256,j.source_binary_sha256,j.fresh_google_response_sha256,
    j.fresh_google_text_sha256,j.fresh_block_count,v_sim,v_ratio,j.recovered_candidate_count,v_fp,'passed')
  on conflict(job_id) do update set source_binary_sha256=excluded.source_binary_sha256,fresh_google_response_sha256=excluded.fresh_google_response_sha256,
    fresh_google_text_sha256=excluded.fresh_google_text_sha256,fresh_block_count=excluded.fresh_block_count,old_fresh_text_similarity=excluded.old_fresh_text_similarity,
    fresh_old_char_ratio=excluded.fresh_old_char_ratio,recovered_candidate_count=excluded.recovered_candidate_count,recovered_ocr_fingerprint=excluded.recovered_ocr_fingerprint,status='passed',created_at=now();
  update public.source_page_ocr_recovery_jobs_v1 set status='completed',stage='completed',lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','similarity',v_sim,'char_ratio',v_ratio,'missing_candidates',j.recovered_candidate_count,'recovered_ocr_fingerprint',v_fp);
end $$;

create or replace function public.fail_source_page_ocr_recovery_job_v1(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default false)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare j public.source_page_ocr_recovery_jobs_v1%rowtype; v_status text;
begin
  select * into j from public.source_page_ocr_recovery_jobs_v1 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'page_ocr_recovery_v1_lease_invalid'; end if;
  v_status:=case when p_retryable and j.attempt_count<4 then 'queued' else 'failed' end;
  update public.source_page_ocr_recovery_jobs_v1 set status=v_status,stage='failed',lease_token=null,lease_expires_at=null,
    error_message=left(coalesce(p_error,'unknown error'),3000),updated_at=now(),finished_at=case when v_status='failed' then now() else null end where id=j.id;
  return jsonb_build_object('status',v_status,'attempt_count',j.attempt_count);
end $$;

create or replace view public.source_page_ocr_recovery_gate_v1 as
with expected as (select count(*)::integer expected_pages from public.source_page_inventory_capture_v1),
counts as (
  select count(*)::integer jobs,count(*) filter(where status='completed')::integer completed,
         count(*) filter(where status='needs_review')::integer needs_review,count(*) filter(where status='failed')::integer failed,
         count(*) filter(where source_binary_sha256 ~ '^[0-9a-f]{64}$')::integer binary_receipts
  from public.source_page_ocr_recovery_jobs_v1
),
receipts as (
  select count(*)::integer passed_receipts,coalesce(sum(recovered_candidate_count),0)::integer recovered_candidates
  from public.source_page_ocr_recovery_receipts_v1 where status='passed'
)
select e.expected_pages,c.jobs,c.completed,c.needs_review,c.failed,c.binary_receipts,r.passed_receipts,r.recovered_candidates,
       case when c.jobs<>e.expected_pages then 'failed' when c.completed<>e.expected_pages then 'failed'
            when c.needs_review<>0 or c.failed<>0 then 'failed' when c.binary_receipts<>e.expected_pages or r.passed_receipts<>e.expected_pages then 'failed'
            else 'passed' end as recovery_gate,
       case when c.jobs<>e.expected_pages then 'page_recovery_jobs_incomplete' when c.failed<>0 then 'page_recovery_failed'
            when c.needs_review<>0 then 'page_recovery_review_required' when c.completed<>e.expected_pages then 'page_recovery_incomplete'
            when c.binary_receipts<>e.expected_pages then 'source_binary_receipts_incomplete' when r.passed_receipts<>e.expected_pages then 'page_recovery_receipts_incomplete'
            else 'passed' end as gate_reason
from expected e cross join counts c cross join receipts r;

create or replace function public.enqueue_source_page_article_inventory_jobs_v4()
returns integer language plpgsql security definer set search_path='pg_catalog','public' as $$
declare v_freeze uuid; v_count integer;
begin
  if not exists(select 1 from public.source_page_ocr_recovery_gate_v1 where recovery_gate='passed') then raise exception 'inventory_v4_page_ocr_recovery_not_ready'; end if;
  select freeze_receipt_id into v_freeze from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed';
  if v_freeze is null then raise exception 'inventory_v4_freeze_not_ready'; end if;
  insert into public.source_page_article_inventory_jobs_v1(
    page_identity_source_image_id,inventory_source_image_id,freeze_receipt_id,source_ocr_json_sha256,block_count,existing_article_count,
    page_article_set_fingerprint,requires_third_pass,inventory_version
  )
  select c.page_identity_source_image_id,c.inventory_source_image_id,v_freeze,r.recovered_ocr_fingerprint,r.fresh_block_count,c.existing_article_count,p.article_set_fingerprint,
         (c.requires_third_pass or r.recovered_candidate_count>0 or r.old_fresh_text_similarity<0.90),'page_article_inventory_v4_recovered_ocr'
  from public.source_page_inventory_capture_v1 c
  join public.source_page_ocr_recovery_receipts_v1 r on r.page_identity_source_image_id=c.page_identity_source_image_id and r.source_image_id=c.inventory_source_image_id and r.status='passed'
  cross join lateral public.inventory_page_article_set_proof_v1(c.page_identity_source_image_id) p
  where p.article_count=c.existing_article_count
  on conflict(page_identity_source_image_id,freeze_receipt_id,inventory_version) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace view public.source_page_article_inventory_blocks_v1 as
select j.id job_id,b.block_index,b.block_text,b.x_min,b.y_min,b.x_max,b.y_max,b.ocr_confidence,b.source_ocr_json_sha256
from public.source_page_article_inventory_jobs_v1 j
join public.source_ocr_blocks_v1 b on b.source_image_id=j.inventory_source_image_id and b.page_index=0 and b.source_ocr_json_sha256=j.source_ocr_json_sha256
where j.inventory_version<>'page_article_inventory_v4_recovered_ocr'
union all
select j.id,b.block_index,b.block_text,b.x_min,b.y_min,b.x_max,b.y_max,b.ocr_confidence,j.source_ocr_json_sha256
from public.source_page_article_inventory_jobs_v1 j
join public.source_page_ocr_recovery_receipts_v1 r on r.page_identity_source_image_id=j.page_identity_source_image_id and r.source_image_id=j.inventory_source_image_id and r.recovered_ocr_fingerprint=j.source_ocr_json_sha256 and r.status='passed'
join public.source_page_ocr_recovery_fresh_blocks_v1 b on b.job_id=r.job_id
where j.inventory_version='page_article_inventory_v4_recovered_ocr';

-- Formal inventory claims are now impossible until the page recovery gate has passed,
-- and then only the recovered-OCR inventory version is claimable.
create or replace function public.claim_source_page_article_inventory_job_v3(p_job_id uuid default null::uuid,p_lease_seconds integer default 240)
returns setof public.source_page_article_inventory_jobs_v1
language plpgsql security definer set search_path='pg_catalog','public' as $$
declare v_id uuid;v_status text;v_token uuid:=gen_random_uuid();
begin
  if not exists(select 1 from public.formal_corpus_freeze_gate_v2 where freeze_gate_v2='passed') then raise exception 'inventory_v3_freeze_stale'; end if;
  if not exists(select 1 from public.source_page_ocr_recovery_gate_v1 where recovery_gate='passed') then raise exception 'inventory_v4_page_ocr_recovery_not_ready'; end if;
  if p_job_id is null then
    select id,status into v_id,v_status from public.source_page_article_inventory_jobs_v1
    where inventory_version='page_article_inventory_v4_recovered_ocr'
      and (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now())) and attempt_count<4
    order by requires_third_pass desc,created_at for update skip locked limit 1;
  else
    select id,status into v_id,v_status from public.source_page_article_inventory_jobs_v1
    where id=p_job_id and inventory_version='page_article_inventory_v4_recovered_ocr'
      and (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now())) and attempt_count<4
    for update skip locked;
  end if;
  if v_id is null then return; end if;
  update public.source_page_article_inventory_jobs_v1 set status='running',lease_token=v_token,
    lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,coalesce(p_lease_seconds,240)))),
    attempt_count=attempt_count+case when v_status='running' then 1 else 0 end,error_message=null,updated_at=now() where id=v_id;
  return query select * from public.source_page_article_inventory_jobs_v1 where id=v_id;
end $$;

revoke all on function public.enqueue_source_page_ocr_recovery_jobs_v1() from public,anon,authenticated;
revoke all on function public.claim_source_page_ocr_recovery_job_v1(integer) from public,anon,authenticated;
revoke all on function public.record_source_page_ocr_recovery_fresh_v1(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_source_page_ocr_recovery_job_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.fail_source_page_ocr_recovery_job_v1(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.enqueue_source_page_article_inventory_jobs_v4() from public,anon,authenticated;
revoke all on function public.claim_source_page_article_inventory_job_v3(uuid,integer) from public,anon,authenticated;
grant execute on function public.enqueue_source_page_ocr_recovery_jobs_v1() to service_role;
grant execute on function public.claim_source_page_ocr_recovery_job_v1(integer) to service_role;
grant execute on function public.record_source_page_ocr_recovery_fresh_v1(uuid,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.finalize_source_page_ocr_recovery_job_v1(uuid,uuid) to service_role;
grant execute on function public.fail_source_page_ocr_recovery_job_v1(uuid,uuid,text,boolean) to service_role;
grant execute on function public.enqueue_source_page_article_inventory_jobs_v4() to service_role;
grant execute on function public.claim_source_page_article_inventory_job_v3(uuid,integer) to service_role;
revoke all on public.source_page_ocr_recovery_gate_v1 from public,anon,authenticated;
grant select on public.source_page_ocr_recovery_gate_v1 to service_role;

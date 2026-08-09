create function public.analysis_category_catalog_fingerprint_v4()
returns text
language sql stable security definer set search_path=pg_catalog,public,extensions as $$
with c as (
  select coalesce(string_agg(jsonb_build_array(id,name_ja,coalesce(parent_id,''),coalesce(description,''),keywords)::text,'|' order by id),'') payload
  from public.analysis_categories where is_active=true
)
select encode(extensions.digest(convert_to(payload,'UTF8'),'sha256'),'hex') from c;
$$;

create view public.formal_article_classification_input_v4 as
with blocks as (
  select b.article_id,
         jsonb_agg(jsonb_build_object('block_index',b.block_index,'text',b.block_text,'x_min',b.x_min,'y_min',b.y_min,'x_max',b.x_max,'y_max',b.y_max,'ocr_confidence',b.ocr_confidence) order by b.x_min,b.y_min,b.block_index) blocks_json
  from public.formal_source_grounded_article_blocks_v4 b
  group by b.article_id
)
select g.article_id,g.source_region_id,g.partition_job_id,g.source_region_sha256,g.current_source_raw_ocr_sha256,
       fg.freeze_receipt_id,public.analysis_category_catalog_fingerprint_v4() category_catalog_fingerprint,
       b.blocks_json,
       encode(extensions.digest(convert_to(jsonb_build_object('article_id',g.article_id,'source_region_sha256',g.source_region_sha256,'blocks',b.blocks_json)::text,'UTF8'),'sha256'),'hex') classification_input_sha256
from public.formal_source_grounded_articles_v4 g
join blocks b on b.article_id=g.article_id
join public.formal_corpus_freeze_gate_v1 fg on fg.freeze_gate='passed';

create table public.article_profiles_v4 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  source_region_id uuid not null references public.article_source_regions(id),
  source_partition_job_id uuid not null references public.source_page_partition_jobs_v3(id),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  source_region_sha256 text not null check(source_region_sha256 ~ '^[0-9a-f]{64}$'),
  source_ocr_sha256 text not null check(source_ocr_sha256 ~ '^[0-9a-f]{64}$'),
  category_catalog_fingerprint text not null check(category_catalog_fingerprint ~ '^[0-9a-f]{64}$'),
  classification_input_sha256 text not null check(classification_input_sha256 ~ '^[0-9a-f]{64}$'),
  classification_status text not null check(classification_status in ('categorized','no_matching_category')),
  primary_category text references public.analysis_categories(id),
  consumer_scene text,
  market_signal text,
  product_type text,
  consumer_need text,
  confidence numeric not null check(confidence>=0 and confidence<=1),
  reason text not null,
  source_anchor text,
  classifier_model text not null,
  critic_model text not null,
  classifier_version text not null default 'article_category_profile_v4_source_grounded_dual',
  evidence_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(article_id,freeze_receipt_id,classifier_version,classification_input_sha256,category_catalog_fingerprint)
);

create table public.article_category_memberships_v4 (
  profile_id uuid not null references public.article_profiles_v4(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  category_id text not null references public.analysis_categories(id),
  score numeric not null check(score>=0 and score<=1),
  confidence numeric not null check(confidence>=0 and confidence<=1),
  source_anchor text not null,
  reason text not null,
  evidence_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(profile_id,category_id),
  unique(article_id,profile_id,category_id)
);

create table public.article_classification_jobs_v4 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  source_region_id uuid not null references public.article_source_regions(id),
  source_partition_job_id uuid not null references public.source_page_partition_jobs_v3(id),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  source_region_sha256 text not null,
  source_ocr_sha256 text not null,
  category_catalog_fingerprint text not null,
  classification_input_sha256 text not null,
  blocks_json jsonb not null,
  classifier_version text not null default 'article_category_profile_v4_source_grounded_dual',
  status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed')),
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_class text,
  error_message text,
  result_json jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(article_id,freeze_receipt_id,classifier_version,classification_input_sha256,category_catalog_fingerprint)
);
create index article_classification_jobs_v4_status_idx on public.article_classification_jobs_v4(status,next_retry_at,created_at);

create function public.enqueue_article_classification_jobs_v4()
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;begin
  if (select source_region_gate from public.article_source_region_gate_v4)<>'passed' then raise exception 'classification_v4_source_region_gate_not_passed'; end if;
  if (select freeze_gate from public.formal_corpus_freeze_gate_v1)<>'passed' then raise exception 'classification_v4_freeze_gate_not_passed'; end if;
  with ins as (
    insert into public.article_classification_jobs_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,category_catalog_fingerprint,classification_input_sha256,blocks_json)
    select i.article_id,i.source_region_id,i.partition_job_id,i.freeze_receipt_id,i.source_region_sha256,i.current_source_raw_ocr_sha256,i.category_catalog_fingerprint,i.classification_input_sha256,i.blocks_json
    from public.formal_article_classification_input_v4 i
    on conflict do nothing returning 1
  ) select count(*)::integer into v_count from ins;
  return v_count;
end $$;

create function public.claim_article_classification_jobs_v4(p_limit integer default 16,p_lease_seconds integer default 300)
returns setof public.article_classification_jobs_v4
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_token uuid:=gen_random_uuid();begin
  return query with picked as (
    select id from public.article_classification_jobs_v4
    where (status='queued' or (status='running' and (lease_expires_at is null or lease_expires_at<now())))
      and attempt_count<4 and (next_retry_at is null or next_retry_at<=now())
    order by created_at for update skip locked limit greatest(1,least(32,coalesce(p_limit,16)))
  ), upd as (
    update public.article_classification_jobs_v4 j
    set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(120,least(600,coalesce(p_lease_seconds,300)))),attempt_count=attempt_count+1,started_at=coalesce(started_at,now()),updated_at=now(),error_message=null
    from picked p where j.id=p.id returning j.*
  ) select * from upd;
end $$;

create function public.complete_article_classification_job_v4(p_job_id uuid,p_lease_token uuid,p_classifier_model text,p_critic_model text,p_classifier jsonb,p_critic jsonb)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  j public.article_classification_jobs_v4%rowtype;
  i public.formal_article_classification_input_v4%rowtype;
  v_status_a text;v_status_b text;v_primary_a text;v_primary_b text;
  v_conf_a numeric;v_conf_b numeric;v_members_a text[];v_members_b text[];
  v_profile_id uuid;v_reason text;v_anchor text;
begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id for update;
  if not found then raise exception 'classification_v4_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'classification_v4_job_lease_invalid'; end if;
  select * into i from public.formal_article_classification_input_v4 where article_id=j.article_id;
  if not found or i.freeze_receipt_id<>j.freeze_receipt_id or i.source_region_id<>j.source_region_id or i.partition_job_id<>j.source_partition_job_id or i.source_region_sha256<>j.source_region_sha256 or i.current_source_raw_ocr_sha256<>j.source_ocr_sha256 or i.category_catalog_fingerprint<>j.category_catalog_fingerprint or i.classification_input_sha256<>j.classification_input_sha256 then raise exception 'classification_v4_input_stale'; end if;
  if coalesce(btrim(p_classifier_model),'')='' or coalesce(btrim(p_critic_model),'')='' then raise exception 'classification_v4_models_required'; end if;

  v_status_a:=p_classifier->>'classification_status';v_status_b:=p_critic->>'classification_status';
  v_primary_a:=nullif(btrim(p_classifier->>'primary_category'),'');v_primary_b:=nullif(btrim(p_critic->>'primary_category'),'');
  v_conf_a:=coalesce((p_classifier->>'confidence')::numeric,0);v_conf_b:=coalesce((p_critic->>'confidence')::numeric,0);
  select coalesce(array_agg(category_id order by category_id),'{}'::text[]) into v_members_a from (select distinct x.category_id from jsonb_to_recordset(coalesce(p_classifier->'memberships','[]'::jsonb)) x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)) q;
  select coalesce(array_agg(category_id order by category_id),'{}'::text[]) into v_members_b from (select distinct x.category_id from jsonb_to_recordset(coalesce(p_critic->'memberships','[]'::jsonb)) x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)) q;

  if v_status_a not in ('categorized','no_matching_category') or v_status_b not in ('categorized','no_matching_category')
     or v_status_a<>v_status_b or v_primary_a is distinct from v_primary_b or v_members_a<>v_members_b or least(v_conf_a,v_conf_b)<0.70 then
    update public.article_classification_jobs_v4 set status='needs_review',result_json=jsonb_build_object('classifier',p_classifier,'critic',p_critic),last_error_class='classification_disagreement',error_message='dual classifier disagreement or confidence below 0.70',lease_token=null,lease_expires_at=null,next_retry_at=null,updated_at=now() where id=j.id;
    return jsonb_build_object('status','needs_review','reason','dual_classifier_disagreement_or_low_confidence');
  end if;

  if v_status_a='no_matching_category' then
    if v_primary_a is not null or cardinality(v_members_a)<>0 then raise exception 'classification_v4_no_match_must_have_no_memberships'; end if;
  else
    if v_primary_a is null or cardinality(v_members_a)<1 or not(v_primary_a=any(v_members_a)) then raise exception 'classification_v4_primary_membership_invalid'; end if;
    if exists(select 1 from unnest(v_members_a) c left join public.analysis_categories ac on ac.id=c and ac.is_active=true where ac.id is null) then raise exception 'classification_v4_inactive_or_unknown_category'; end if;
    if not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,p_classifier->>'source_anchor')
       or not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,p_critic->>'source_anchor') then raise exception 'classification_v4_profile_anchor_not_grounded'; end if;
    if exists(
      select 1 from jsonb_to_recordset(p_classifier->'memberships') x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)
      where not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,x.source_anchor)
    ) or exists(
      select 1 from jsonb_to_recordset(p_critic->'memberships') x(category_id text,score numeric,confidence numeric,source_anchor text,reason text)
      where not public.source_region_anchor_unique_block_v4(j.article_id,j.source_region_id,x.source_anchor)
    ) then raise exception 'classification_v4_membership_anchor_not_grounded'; end if;
  end if;

  v_reason:=coalesce(p_classifier->>'reason','');v_anchor:=nullif(p_classifier->>'source_anchor','');
  insert into public.article_profiles_v4(article_id,source_region_id,source_partition_job_id,freeze_receipt_id,source_region_sha256,source_ocr_sha256,category_catalog_fingerprint,classification_input_sha256,classification_status,primary_category,consumer_scene,market_signal,product_type,consumer_need,confidence,reason,source_anchor,classifier_model,critic_model,classifier_version,evidence_json,updated_at)
  values(j.article_id,j.source_region_id,j.source_partition_job_id,j.freeze_receipt_id,j.source_region_sha256,j.source_ocr_sha256,j.category_catalog_fingerprint,j.classification_input_sha256,v_status_a,v_primary_a,p_classifier->>'consumer_scene',p_classifier->>'market_signal',p_classifier->>'product_type',p_classifier->>'consumer_need',least(v_conf_a,v_conf_b),v_reason,v_anchor,left(p_classifier_model,200),left(p_critic_model,200),j.classifier_version,jsonb_build_object('classifier',p_classifier,'critic',p_critic),now())
  on conflict(article_id,freeze_receipt_id,classifier_version,classification_input_sha256,category_catalog_fingerprint)
  do update set source_region_id=excluded.source_region_id,source_partition_job_id=excluded.source_partition_job_id,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,classification_status=excluded.classification_status,primary_category=excluded.primary_category,consumer_scene=excluded.consumer_scene,market_signal=excluded.market_signal,product_type=excluded.product_type,consumer_need=excluded.consumer_need,confidence=excluded.confidence,reason=excluded.reason,source_anchor=excluded.source_anchor,classifier_model=excluded.classifier_model,critic_model=excluded.critic_model,evidence_json=excluded.evidence_json,updated_at=now()
  returning id into v_profile_id;

  delete from public.article_category_memberships_v4 where profile_id=v_profile_id;
  if v_status_a='categorized' then
    insert into public.article_category_memberships_v4(profile_id,article_id,category_id,score,confidence,source_anchor,reason,evidence_json)
    select v_profile_id,j.article_id,a.category_id,least(coalesce(a.score,0),coalesce(c.score,0)),least(coalesce(a.confidence,0),coalesce(c.confidence,0)),a.source_anchor,coalesce(a.reason,''),jsonb_build_object('classifier',to_jsonb(a),'critic',to_jsonb(c))
    from jsonb_to_recordset(p_classifier->'memberships') a(category_id text,score numeric,confidence numeric,source_anchor text,reason text)
    join jsonb_to_recordset(p_critic->'memberships') c(category_id text,score numeric,confidence numeric,source_anchor text,reason text) using(category_id);
  end if;

  update public.article_classification_jobs_v4 set status='completed',result_json=jsonb_build_object('classifier',p_classifier,'critic',p_critic,'profile_id',v_profile_id),lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed','profile_id',v_profile_id,'classification_status',v_status_a);
end $$;

create function public.fail_article_classification_job_v4(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.article_classification_jobs_v4%rowtype;v_retry boolean;v_delay integer;begin
  select * into j from public.article_classification_jobs_v4 where id=p_job_id for update;
  if not found then raise exception 'classification_v4_job_missing'; end if;
  if j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'classification_v4_job_lease_invalid'; end if;
  v_retry:=coalesce(p_retryable,true) and j.attempt_count<4;v_delay:=least(600,30*(2^greatest(0,j.attempt_count-1))::integer);
  update public.article_classification_jobs_v4 set status=case when v_retry then 'queued' else 'failed' end,last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),error_message=left(coalesce(p_error_message,'classification worker failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,finished_at=case when v_retry then null else now() end,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',j.attempt_count);
end $$;

create function public.requeue_article_classification_job_v4(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.article_classification_jobs_v4 set status='queued',attempt_count=0,next_retry_at=null,last_error_class=null,error_message=null,finished_at=null,lease_token=null,lease_expires_at=null,updated_at=now() where id=p_job_id and status in ('needs_review','failed');
  if not found then raise exception 'classification_v4_job_not_reviewable'; end if;
  return jsonb_build_object('status','queued','job_id',p_job_id);
end $$;

create or replace view public.formal_category_memberships_v4 as
select m.article_id,m.category_id,m.score,m.confidence,'article_category_profile_v4_source_grounded_dual'::text source,
       array[]::text[] match_terms,m.reason,m.created_at,m.updated_at,
       g.analysis_body_sha256 source_clean_body_sha256,p.source_region_id,p.source_region_sha256,p.source_partition_job_id,p.freeze_receipt_id
from public.article_category_memberships_v4 m
join public.article_profiles_v4 p on p.id=m.profile_id and p.article_id=m.article_id
join public.formal_article_classification_input_v4 i on i.article_id=p.article_id
join public.formal_source_grounded_articles_v4 g on g.article_id=p.article_id
join public.analysis_categories c on c.id=m.category_id and c.is_active=true
where p.classifier_version='article_category_profile_v4_source_grounded_dual'
  and p.classification_status='categorized'
  and p.freeze_receipt_id=i.freeze_receipt_id
  and p.source_region_id=i.source_region_id
  and p.source_partition_job_id=i.partition_job_id
  and p.source_region_sha256=i.source_region_sha256
  and p.source_ocr_sha256=i.current_source_raw_ocr_sha256
  and p.category_catalog_fingerprint=i.category_catalog_fingerprint
  and p.classification_input_sha256=i.classification_input_sha256;

create view public.category_classification_gate_v4 as
with i as (select * from public.formal_article_classification_input_v4),
p as (
  select p.* from public.article_profiles_v4 p join i on i.article_id=p.article_id
  where p.classifier_version='article_category_profile_v4_source_grounded_dual'
    and p.freeze_receipt_id=i.freeze_receipt_id and p.source_region_id=i.source_region_id and p.source_partition_job_id=i.partition_job_id
    and p.source_region_sha256=i.source_region_sha256 and p.source_ocr_sha256=i.current_source_raw_ocr_sha256
    and p.category_catalog_fingerprint=i.category_catalog_fingerprint and p.classification_input_sha256=i.classification_input_sha256
), profile_checks as (
  select p.article_id,p.classification_status,
         (select count(*) from public.article_category_memberships_v4 m where m.profile_id=p.id) membership_count,
         p.primary_category
  from p
), invalid as (
  select count(*)::integer n from profile_checks x
  where (x.classification_status='categorized' and (x.membership_count<1 or x.primary_category is null))
     or (x.classification_status='no_matching_category' and (x.membership_count<>0 or x.primary_category is not null))
)
select (select count(*)::integer from i) formal_article_count,(select count(*)::integer from p) profiled_article_count,
       (select count(*)::integer from p where classification_status='categorized') categorized_article_count,
       (select count(*)::integer from p where classification_status='no_matching_category') no_matching_category_count,
       (select n from invalid) invalid_profile_count,
       (select count(*)::integer from public.article_classification_jobs_v4 where status='needs_review') needs_review_job_count,
       case when (select count(*) from i)>0 and (select count(*) from i)=(select count(*) from p) and (select n from invalid)=0 and (select count(*) from public.article_classification_jobs_v4 where status='needs_review')=0 then 'passed' else 'failed' end category_classification_gate,
       case when (select count(*) from i)=0 then 'source_grounded_articles_required' when (select count(*) from i)<>(select count(*) from p) then 'source_grounded_profiles_missing' when (select n from invalid)>0 then 'profile_membership_consistency_failed' when (select count(*) from public.article_classification_jobs_v4 where status='needs_review')>0 then 'classification_review_required' else 'passed' end gate_reason;

alter table public.article_profiles_v4 enable row level security;
alter table public.article_category_memberships_v4 enable row level security;
alter table public.article_classification_jobs_v4 enable row level security;
revoke all on table public.article_profiles_v4 from anon,authenticated;
revoke all on table public.article_category_memberships_v4 from anon,authenticated;
revoke all on table public.article_classification_jobs_v4 from anon,authenticated;
revoke all on table public.formal_article_classification_input_v4 from anon,authenticated;
revoke all on table public.formal_category_memberships_v4 from anon,authenticated;
revoke all on table public.category_classification_gate_v4 from anon,authenticated;
grant all on table public.article_profiles_v4 to service_role;
grant all on table public.article_category_memberships_v4 to service_role;
grant all on table public.article_classification_jobs_v4 to service_role;
grant select on table public.formal_article_classification_input_v4 to service_role;
grant select on table public.formal_category_memberships_v4 to service_role;
grant select on table public.category_classification_gate_v4 to service_role;
revoke execute on function public.analysis_category_catalog_fingerprint_v4() from public,anon,authenticated;
revoke execute on function public.enqueue_article_classification_jobs_v4() from public,anon,authenticated;
revoke execute on function public.claim_article_classification_jobs_v4(integer,integer) from public,anon,authenticated;
revoke execute on function public.complete_article_classification_job_v4(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke execute on function public.fail_article_classification_job_v4(uuid,uuid,text,boolean,text) from public,anon,authenticated;
revoke execute on function public.requeue_article_classification_job_v4(uuid) from public,anon,authenticated;
grant execute on function public.analysis_category_catalog_fingerprint_v4() to service_role;
grant execute on function public.enqueue_article_classification_jobs_v4() to service_role;
grant execute on function public.claim_article_classification_jobs_v4(integer,integer) to service_role;
grant execute on function public.complete_article_classification_job_v4(uuid,uuid,text,text,jsonb,jsonb) to service_role;
grant execute on function public.fail_article_classification_job_v4(uuid,uuid,text,boolean,text) to service_role;
grant execute on function public.requeue_article_classification_job_v4(uuid) to service_role;
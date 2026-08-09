create table public.formal_corpus_zero_audit_receipts_v2 (
  id uuid primary key default gen_random_uuid(),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  article_count integer not null,
  source_capture_count integer not null,
  source_page_identity_count integer not null,
  article_set_fingerprint text not null,
  source_truth_fingerprint text not null,
  page_identity_fingerprint text not null,
  exact_clean_body_duplicate_groups integer not null,
  source_index_collision_groups integer not null,
  same_date_headline_near_pairs integer not null,
  same_date_body_near_pairs integer not null,
  duplicate_reference_chains integer not null,
  self_duplicate_cycles integer not null,
  mutual_duplicate_cycles integer not null,
  hard_ads_in_formal integer not null,
  article_source_date_mismatch integer not null,
  source_hash_mismatch integer not null,
  clean_body_hash_mismatch integer not null,
  storage_identity_duplicate_groups integer not null,
  cross_capture_near_pairs integer not null,
  page_identity_gate text not null,
  audit_status text not null check(audit_status in ('passed','failed')),
  created_at timestamptz not null default now()
);
create index formal_corpus_zero_audit_receipts_v2_freeze_idx on public.formal_corpus_zero_audit_receipts_v2(freeze_receipt_id,created_at desc);

create function public.run_formal_corpus_zero_audit_v2()
returns uuid
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare
  v_freeze_id uuid;v_snap record;v_identity_gate text;v_id uuid;
  v_exact integer;v_index integer;v_h integer;v_b integer;v_chain integer;v_self integer;v_mutual integer;v_ads integer;v_date integer;v_sh integer;v_ch integer;v_storage integer;v_cross integer;v_status text;
begin
  select freeze_receipt_id into v_freeze_id from public.formal_corpus_freeze_gate_v1 where freeze_gate='passed';
  if v_freeze_id is null then raise exception 'zero_audit_v2_current_freeze_missing_or_stale'; end if;
  select * into v_snap from public.formal_corpus_freeze_snapshot_v1();
  select page_identity_gate into v_identity_gate from public.formal_source_page_identity_gate_v1;

  with fc as materialized (
    select f.id,f.source_image_id,f.headline,a.analysis_body_clean,a.analysis_body_clean_sha256,a.article_index,a.article_date_normalized,a.hard_advertisement_flag,a.source_ocr_sha256,m.page_identity_source_image_id
    from public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
  ), same_date_pairs as materialized (
    select a.id a_id,b.id b_id,similarity(public.normalize_article_headline_v1(a.headline),public.normalize_article_headline_v1(b.headline)) hsim,similarity(coalesce(a.analysis_body_clean,''),coalesce(b.analysis_body_clean,'')) bsim
    from fc a join fc b on a.id<b.id and a.article_date_normalized=b.article_date_normalized
  ), graph as materialized (
    select a.id,a.duplicate_of_article_id,t.duplicate_of_article_id target_next from public.articles a left join public.articles t on t.id=a.duplicate_of_article_id where a.duplicate_of_article_id is not null
  ), sources as materialized (
    select distinct s.id,s.storage_etag,s.storage_size_bytes from public.source_images s join (select distinct source_image_id from fc) x on x.source_image_id=s.id
  ), cross_capture as materialized (
    select a.id a_id,b.id b_id,
           similarity(public.normalize_article_headline_v1(a.headline),public.normalize_article_headline_v1(b.headline)) hsim,
           similarity(coalesce(a.analysis_body_clean,''),coalesce(b.analysis_body_clean,'')) bsim
    from fc a join fc b on a.id<b.id and a.page_identity_source_image_id=b.page_identity_source_image_id and a.source_image_id<>b.source_image_id
  )
  select
    (select count(*) from (select analysis_body_clean_sha256 from fc group by analysis_body_clean_sha256 having count(*)>1) q),
    (select count(*) from (select source_image_id,article_index from fc group by source_image_id,article_index having count(*)>1) q),
    (select count(*) from same_date_pairs where hsim>=0.55),
    (select count(*) from same_date_pairs where bsim>=0.50),
    (select count(*) from graph where target_next is not null),
    (select count(*) from public.articles a where a.duplicate_of_article_id=a.id),
    (select count(*) from public.articles a join public.articles b on b.id=a.duplicate_of_article_id where b.duplicate_of_article_id=a.id and a.id<b.id),
    (select count(*) from fc where hard_advertisement_flag),
    (select count(*) from fc f join public.source_images s on s.id=f.source_image_id where f.article_date_normalized is distinct from s.publication_date),
    (select count(*) from fc f join public.source_images s on s.id=f.source_image_id where f.source_ocr_sha256 is distinct from s.raw_ocr_sha256),
    (select count(*) from fc f where f.analysis_body_clean_sha256 is distinct from encode(extensions.digest(convert_to(coalesce(f.analysis_body_clean,''),'UTF8'),'sha256'),'hex')),
    (select count(*) from (select storage_etag,storage_size_bytes from sources where storage_etag is not null group by storage_etag,storage_size_bytes having count(*)>1) q),
    (select count(*) from cross_capture where greatest(hsim,bsim)>=0.20)
  into v_exact,v_index,v_h,v_b,v_chain,v_self,v_mutual,v_ads,v_date,v_sh,v_ch,v_storage,v_cross;

  v_status:=case when v_exact=0 and v_index=0 and v_h=0 and v_b=0 and v_chain=0 and v_self=0 and v_mutual=0 and v_ads=0 and v_date=0 and v_sh=0 and v_ch=0 and v_storage=0 and v_cross=0 and v_identity_gate='passed' then 'passed' else 'failed' end;

  insert into public.formal_corpus_zero_audit_receipts_v2(
    freeze_receipt_id,article_count,source_capture_count,source_page_identity_count,article_set_fingerprint,source_truth_fingerprint,page_identity_fingerprint,
    exact_clean_body_duplicate_groups,source_index_collision_groups,same_date_headline_near_pairs,same_date_body_near_pairs,duplicate_reference_chains,self_duplicate_cycles,mutual_duplicate_cycles,hard_ads_in_formal,article_source_date_mismatch,source_hash_mismatch,clean_body_hash_mismatch,storage_identity_duplicate_groups,cross_capture_near_pairs,page_identity_gate,audit_status
  ) values(
    v_freeze_id,v_snap.article_count,v_snap.source_capture_count,v_snap.source_page_identity_count,v_snap.article_set_fingerprint,v_snap.source_truth_fingerprint,v_snap.page_identity_fingerprint,
    v_exact,v_index,v_h,v_b,v_chain,v_self,v_mutual,v_ads,v_date,v_sh,v_ch,v_storage,v_cross,v_identity_gate,v_status
  ) returning id into v_id;
  return v_id;
end $$;

create view public.formal_corpus_zero_audit_gate_v2 as
with fg as (select * from public.formal_corpus_freeze_gate_v1), latest as (
  select a.* from public.formal_corpus_zero_audit_receipts_v2 a join fg on fg.freeze_receipt_id=a.freeze_receipt_id order by a.created_at desc limit 1
)
select fg.freeze_receipt_id,l.id zero_audit_receipt_id,l.audit_status,
       case when fg.freeze_gate<>'passed' then 'failed'
            when l.id is null then 'failed'
            when l.article_count<>fg.current_article_count or l.source_capture_count<>fg.current_source_capture_count or l.source_page_identity_count<>fg.current_source_page_identity_count then 'failed'
            when l.article_set_fingerprint<>fg.current_article_set_fingerprint or l.source_truth_fingerprint<>fg.current_source_truth_fingerprint or l.page_identity_fingerprint<>fg.current_page_identity_fingerprint then 'failed'
            when l.audit_status<>'passed' then 'failed' else 'passed' end zero_audit_gate,
       case when fg.freeze_gate<>'passed' then 'base_freeze_stale' when l.id is null then 'zero_audit_receipt_missing' when l.audit_status<>'passed' then 'zero_audit_failed' when l.article_set_fingerprint<>fg.current_article_set_fingerprint or l.source_truth_fingerprint<>fg.current_source_truth_fingerprint or l.page_identity_fingerprint<>fg.current_page_identity_fingerprint then 'zero_audit_stale' else 'passed' end gate_reason
from fg left join latest l on true;

create view public.formal_corpus_freeze_gate_v2 as
select fg.*,za.zero_audit_receipt_id,za.audit_status zero_audit_status,
       case when fg.freeze_gate='passed' and za.zero_audit_gate='passed' then 'passed' else 'failed' end freeze_gate_v2,
       case when fg.freeze_gate<>'passed' then fg.gate_reason when za.zero_audit_gate<>'passed' then za.gate_reason else 'passed' end gate_reason_v2
from public.formal_corpus_freeze_gate_v1 fg cross join public.formal_corpus_zero_audit_gate_v2 za;

alter table public.formal_corpus_zero_audit_receipts_v2 enable row level security;
revoke all on table public.formal_corpus_zero_audit_receipts_v2 from anon,authenticated,service_role;
grant select on table public.formal_corpus_zero_audit_receipts_v2 to service_role;
revoke all on table public.formal_corpus_zero_audit_gate_v2 from anon,authenticated;
revoke all on table public.formal_corpus_freeze_gate_v2 from anon,authenticated;
grant select on table public.formal_corpus_zero_audit_gate_v2,public.formal_corpus_freeze_gate_v2 to service_role;
revoke execute on function public.run_formal_corpus_zero_audit_v2() from public,anon,authenticated;
grant execute on function public.run_formal_corpus_zero_audit_v2() to service_role;
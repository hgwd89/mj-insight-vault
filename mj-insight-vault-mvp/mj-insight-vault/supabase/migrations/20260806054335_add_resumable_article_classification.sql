insert into public.analysis_categories(id,name_ja,parent_id,description,keywords,is_active)
values('other_unclassified','その他・分類保留',null,'既存カテゴリに十分な根拠をもって分類できない記事。無理なカテゴリ付与を避けるための明示的な保留先。','{}'::text[],true)
on conflict(id) do update set name_ja=excluded.name_ja,description=excluded.description,is_active=true,updated_at=now();

create table if not exists public.article_classification_jobs(
 id uuid primary key default gen_random_uuid(), article_id uuid not null references public.articles(id) on delete cascade,
 status text not null default 'queued' check(status in ('queued','running','completed','failed')),
 classifier_version text not null default 'article_category_profile_v2', model text not null default 'gpt-4o-mini',
 attempt_count integer not null default 0,next_retry_at timestamptz,lease_token uuid,lease_expires_at timestamptz,heartbeat_at timestamptz,
 result_json jsonb not null default '{}'::jsonb,error_message text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz
);
create unique index if not exists article_classification_jobs_article_version_uidx on public.article_classification_jobs(article_id,classifier_version);
create index if not exists article_classification_jobs_claim_idx on public.article_classification_jobs(status,next_retry_at,lease_expires_at,updated_at);
alter table public.article_classification_jobs enable row level security;
revoke all on public.article_classification_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.article_classification_jobs to postgres,service_role;

create or replace function public.enqueue_article_classification_v2(p_force boolean default false,p_model text default 'gpt-4o-mini') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_inserted integer:=0;v_requeued integer:=0;
begin
 insert into public.article_classification_jobs(article_id,status,classifier_version,model,attempt_count,next_retry_at,lease_token,lease_expires_at,heartbeat_at,result_json,error_message,updated_at,finished_at)
 select a.id,'queued','article_category_profile_v2',coalesce(nullif(btrim(p_model),''),'gpt-4o-mini'),0,null,null,null,null,'{}'::jsonb,null,now(),null
 from public.formal_corpus_articles_v1 a
 where p_force or not exists(select 1 from public.article_profiles p where p.article_id=a.id and p.profile_model='article_category_profile_v2') or not exists(select 1 from public.article_category_memberships m where m.article_id=a.id and m.source='article_category_profile_v2')
 on conflict(article_id,classifier_version) do nothing; get diagnostics v_inserted=row_count;
 if p_force then
  update public.article_classification_jobs j set status='queued',model=coalesce(nullif(btrim(p_model),''),'gpt-4o-mini'),attempt_count=0,next_retry_at=null,lease_token=null,lease_expires_at=null,heartbeat_at=null,result_json='{}'::jsonb,error_message=null,updated_at=now(),finished_at=null where j.classifier_version='article_category_profile_v2' and j.status<>'running';get diagnostics v_requeued=row_count;
 else
  update public.article_classification_jobs j set status='queued',next_retry_at=null,lease_token=null,lease_expires_at=null,heartbeat_at=null,error_message=null,updated_at=now(),finished_at=null
  where j.classifier_version='article_category_profile_v2' and j.status in ('completed','failed') and (not exists(select 1 from public.article_profiles p where p.article_id=j.article_id and p.profile_model='article_category_profile_v2') or not exists(select 1 from public.article_category_memberships m where m.article_id=j.article_id and m.source='article_category_profile_v2'));get diagnostics v_requeued=row_count;
 end if;
 return jsonb_build_object('classifier_version','article_category_profile_v2','inserted_jobs',v_inserted,'requeued_jobs',v_requeued,'formal_article_count',(select count(*) from public.formal_corpus_articles_v1),'queued_count',(select count(*) from public.article_classification_jobs where classifier_version='article_category_profile_v2' and status='queued'));
end;$$;

create or replace function public.claim_article_classification_jobs_v2(p_limit integer default 6,p_lease_seconds integer default 210) returns setof public.article_classification_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
begin return query
 with candidates as(select j.id from public.article_classification_jobs j join public.formal_corpus_articles_v1 a on a.id=j.article_id where j.classifier_version='article_category_profile_v2' and (j.next_retry_at is null or j.next_retry_at<=now()) and (j.status='queued' or (j.status='running' and (j.lease_expires_at is null or j.lease_expires_at<=now())) or (j.status='failed' and j.attempt_count<3)) order by case j.status when 'running' then 0 when 'failed' then 1 else 2 end,j.updated_at,j.id for update skip locked limit greatest(1,least(coalesce(p_limit,6),8)))
 update public.article_classification_jobs j set status='running',attempt_count=j.attempt_count+1,lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>greatest(60,least(coalesce(p_lease_seconds,210),300))),heartbeat_at=now(),updated_at=now(),error_message=null from candidates c where j.id=c.id returning j.*;
end;$$;

create or replace function public.complete_article_classification_job_v2(p_job_id uuid,p_lease_token uuid,p_profile jsonb,p_memberships jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.article_classification_jobs%rowtype;v_primary text:=btrim(coalesce(p_profile->>'primary_category',''));v_secondary text[]:=array(select value from jsonb_array_elements_text(case when jsonb_typeof(p_profile->'secondary_categories')='array' then p_profile->'secondary_categories' else '[]'::jsonb end));v_confidence numeric;v_member jsonb;v_category text;v_member_confidence numeric;v_member_score numeric;v_membership_count integer:=0;v_primary_present boolean:=false;
begin
 select * into v_job from public.article_classification_jobs j where j.id=p_job_id and j.status='running' and j.lease_token=p_lease_token and j.lease_expires_at>now() for update;
 if not found then raise exception using errcode='P0002',message='classification_job_lease_lost';end if;
 if not exists(select 1 from public.formal_corpus_articles_v1 a where a.id=v_job.article_id) then raise exception using errcode='23514',message='classification_article_not_formal';end if;
 if jsonb_typeof(p_profile)<>'object' then raise exception using errcode='22023',message='classification_profile_required';end if;
 if jsonb_typeof(p_memberships)<>'array' or jsonb_array_length(p_memberships)=0 then raise exception using errcode='22023',message='classification_memberships_required';end if;
 if v_primary='' then raise exception using errcode='22023',message='classification_primary_category_required';end if;
 begin v_confidence:=(p_profile->>'confidence')::numeric;exception when others then raise exception using errcode='22023',message='classification_confidence_invalid';end;
 if v_confidence<0 or v_confidence>1 then raise exception using errcode='22023',message='classification_confidence_out_of_range';end if;
 create temporary table if not exists pg_temp.validated_memberships(category_id text primary key,score numeric not null,confidence numeric not null,match_terms text[] not null,reason text) on commit drop;truncate pg_temp.validated_memberships;
 for v_member in select value from jsonb_array_elements(p_memberships) loop
  if jsonb_typeof(v_member)<>'object' then continue;end if;v_category:=btrim(coalesce(v_member->>'category_id',''));
  if v_category='' or not exists(select 1 from public.analysis_categories c where c.id=v_category and c.is_active=true) then raise exception using errcode='22023',message='classification_category_invalid',detail=v_category;end if;
  begin v_member_confidence:=(v_member->>'confidence')::numeric;exception when others then raise exception using errcode='22023',message='classification_membership_confidence_invalid';end;
  begin v_member_score:=coalesce(nullif(v_member->>'score','')::numeric,v_member_confidence);exception when others then v_member_score:=v_member_confidence;end;
  if v_member_confidence<0 or v_member_confidence>1 or v_member_score<0 or v_member_score>1 then raise exception using errcode='22023',message='classification_membership_score_out_of_range';end if;
  insert into pg_temp.validated_memberships(category_id,score,confidence,match_terms,reason) values(v_category,v_member_score,v_member_confidence,array(select value from jsonb_array_elements_text(case when jsonb_typeof(v_member->'match_terms')='array' then v_member->'match_terms' else '[]'::jsonb end) limit 12),nullif(btrim(coalesce(v_member->>'reason','')),'')) on conflict(category_id) do update set score=greatest(pg_temp.validated_memberships.score,excluded.score),confidence=greatest(pg_temp.validated_memberships.confidence,excluded.confidence),match_terms=excluded.match_terms,reason=excluded.reason;
 end loop;
 select count(*),bool_or(category_id=v_primary) into v_membership_count,v_primary_present from pg_temp.validated_memberships;
 if v_membership_count=0 then raise exception using errcode='22023',message='classification_no_valid_memberships';end if;
 if not coalesce(v_primary_present,false) then raise exception using errcode='22023',message='classification_primary_not_in_memberships';end if;
 if v_membership_count>4 then raise exception using errcode='22023',message='classification_too_many_memberships';end if;
 insert into public.article_profiles(article_id,profile_model,primary_category,secondary_categories,consumer_scene,market_signal,product_type,consumer_need,confidence,reason,profile_json,updated_at)
 values(v_job.article_id,'article_category_profile_v2',v_primary,v_secondary,nullif(btrim(coalesce(p_profile->>'consumer_scene','')),''),nullif(btrim(coalesce(p_profile->>'market_signal','')),''),nullif(btrim(coalesce(p_profile->>'product_type','')),''),nullif(btrim(coalesce(p_profile->>'consumer_need','')),''),v_confidence,nullif(btrim(coalesce(p_profile->>'reason','')),''),p_profile||jsonb_build_object('classifier_version','article_category_profile_v2','model_used',v_job.model,'classified_at',now()),now())
 on conflict(article_id) do update set profile_model=excluded.profile_model,primary_category=excluded.primary_category,secondary_categories=excluded.secondary_categories,consumer_scene=excluded.consumer_scene,market_signal=excluded.market_signal,product_type=excluded.product_type,consumer_need=excluded.consumer_need,confidence=excluded.confidence,reason=excluded.reason,profile_json=excluded.profile_json,updated_at=now();
 delete from public.article_category_memberships where article_id=v_job.article_id;
 insert into public.article_category_memberships(article_id,category_id,score,confidence,source,match_terms,reason,updated_at) select v_job.article_id,category_id,score,confidence,'article_category_profile_v2',match_terms,reason,now() from pg_temp.validated_memberships;
 update public.article_classification_jobs set status='completed',result_json=jsonb_build_object('profile',p_profile,'memberships',p_memberships),error_message=null,lease_token=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now(),finished_at=now() where id=v_job.id;
 return jsonb_build_object('job_id',v_job.id,'article_id',v_job.article_id,'primary_category',v_primary,'membership_count',v_membership_count,'status','completed');
end;$$;

create or replace function public.fail_article_classification_job_v2(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_job public.article_classification_jobs%rowtype;v_retry boolean;
begin
 select * into v_job from public.article_classification_jobs j where j.id=p_job_id and j.status='running' and j.lease_token=p_lease_token for update;
 if not found then return jsonb_build_object('job_id',p_job_id,'updated',false,'reason','lease_lost');end if;
 v_retry:=coalesce(p_retryable,true) and v_job.attempt_count<3;
 update public.article_classification_jobs set status=case when v_retry then 'queued' else 'failed' end,next_retry_at=case when v_retry then now()+make_interval(secs=>least(300,20*power(2,greatest(0,v_job.attempt_count-1))::integer)) else null end,error_message=left(coalesce(p_error_message,'classification failed'),2000),lease_token=null,lease_expires_at=null,heartbeat_at=now(),updated_at=now(),finished_at=case when v_retry then null else now() end where id=v_job.id;
 return jsonb_build_object('job_id',v_job.id,'article_id',v_job.article_id,'retry_scheduled',v_retry,'attempt_count',v_job.attempt_count);
end;$$;

create or replace view public.article_classification_status_v2 with(security_invoker=true) as
select (select count(*)::integer from public.formal_corpus_articles_v1) formal_article_count,count(*) filter(where j.status='queued')::integer queued_count,count(*) filter(where j.status='running')::integer running_count,count(*) filter(where j.status='completed')::integer completed_count,count(*) filter(where j.status='failed')::integer failed_count,count(*) filter(where j.status='completed' and exists(select 1 from public.article_profiles p where p.article_id=j.article_id and p.profile_model='article_category_profile_v2'))::integer validated_profile_count,count(*) filter(where j.status='completed' and exists(select 1 from public.article_category_memberships m where m.article_id=j.article_id and m.source='article_category_profile_v2'))::integer validated_membership_article_count,min(j.next_retry_at) filter(where j.status='queued' and j.next_retry_at>now()) next_retry_at,max(j.updated_at) last_updated_at
from public.article_classification_jobs j where j.classifier_version='article_category_profile_v2';
revoke all on public.article_classification_status_v2 from public,anon,authenticated;grant select on public.article_classification_status_v2 to postgres,service_role;

create or replace view public.category_classification_gate_v1 with(security_invoker=true) as
with formal as(select id from public.formal_corpus_articles_v1),profiled as(select distinct p.article_id from public.article_profiles p join formal f on f.id=p.article_id where p.profile_model='article_category_profile_v2'),categorized as(select distinct m.article_id from public.article_category_memberships m join formal f on f.id=m.article_id where m.source='article_category_profile_v2'),invalid_memberships as(select count(*)::integer n from public.article_category_memberships m join formal f on f.id=m.article_id left join public.analysis_categories c on c.id=m.category_id and c.is_active=true where m.source='article_category_profile_v2' and c.id is null)
select (select count(*)::integer from formal) formal_article_count,(select count(*)::integer from profiled) profiled_article_count,(select count(*)::integer from categorized) categorized_article_count,(select count(*)::integer from formal f left join profiled p on p.article_id=f.id where p.article_id is null) unprofiled_article_count,(select count(*)::integer from formal f left join categorized c on c.article_id=f.id where c.article_id is null) uncategorized_article_count,(select n from invalid_memberships) invalid_membership_count,case when (select count(*) from formal)=0 then 'failed' when (select count(*) from formal)<>(select count(*) from profiled) then 'failed' when (select count(*) from formal)<>(select count(*) from categorized) then 'failed' when (select n from invalid_memberships)>0 then 'failed' else 'passed' end category_classification_gate,case when (select count(*) from formal)=0 then 'no_formal_articles' when (select count(*) from formal)<>(select count(*) from profiled) then 'unprofiled_articles_exist' when (select count(*) from formal)<>(select count(*) from categorized) then 'uncategorized_articles_exist' when (select n from invalid_memberships)>0 then 'inactive_or_missing_category_memberships_exist' else 'passed' end gate_reason;
revoke all on public.category_classification_gate_v1 from public,anon,authenticated;grant select on public.category_classification_gate_v1 to postgres,service_role;

revoke all on function public.enqueue_article_classification_v2(boolean,text) from public,anon,authenticated;revoke all on function public.claim_article_classification_jobs_v2(integer,integer) from public,anon,authenticated;revoke all on function public.complete_article_classification_job_v2(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;revoke all on function public.fail_article_classification_job_v2(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.enqueue_article_classification_v2(boolean,text) to postgres,service_role;grant execute on function public.claim_article_classification_jobs_v2(integer,integer) to postgres,service_role;grant execute on function public.complete_article_classification_job_v2(uuid,uuid,jsonb,jsonb) to postgres,service_role;grant execute on function public.fail_article_classification_job_v2(uuid,uuid,text,boolean) to postgres,service_role;
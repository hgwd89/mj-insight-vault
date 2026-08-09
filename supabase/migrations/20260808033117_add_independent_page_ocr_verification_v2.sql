begin;

create table public.ocr_verification_page_jobs_v2(
  id uuid primary key default gen_random_uuid(),
  partition_job_id uuid not null unique references public.source_page_partition_jobs_v3(id) on delete cascade,
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id) on delete cascade,
  page_identity_source_image_id uuid not null references public.source_images(id),
  evidence_source_image_id uuid not null references public.source_images(id),
  source_ocr_sha256 text not null check(source_ocr_sha256 ~ '^[0-9a-f]{64}$'),
  region_set_fingerprint text not null check(region_set_fingerprint ~ '^[0-9a-f]{64}$'),
  article_count integer not null check(article_count>0),
  requires_second_pass boolean not null default false,
  status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed')),
  failure_count integer not null default 0,
  lease_token uuid,lease_expires_at timestamptz,
  error_message text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz
);
create table public.ocr_verification_pass_runs_v2(
  id uuid primary key default gen_random_uuid(),job_id uuid not null references public.ocr_verification_page_jobs_v2(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('verifier','critic')),model text not null,provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),unique(job_id,pass_kind)
);
create table public.ocr_verification_transcriptions_v2(
  job_id uuid not null references public.ocr_verification_page_jobs_v2(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('verifier','critic')),
  article_id uuid not null references public.articles(id),
  transcription text not null,transcription_sha256 text not null check(transcription_sha256 ~ '^[0-9a-f]{64}$'),
  confidence numeric not null check(confidence between 0 and 1),
  proper_noun_status text not null check(proper_noun_status in ('passed','not_applicable','failed')),
  visual_proper_nouns text[] not null default '{}',
  reason text,created_at timestamptz not null default now(),
  primary key(job_id,pass_kind,article_id)
);

alter table public.ocr_verification_page_jobs_v2 enable row level security;
alter table public.ocr_verification_pass_runs_v2 enable row level security;
alter table public.ocr_verification_transcriptions_v2 enable row level security;
revoke all on public.ocr_verification_page_jobs_v2,public.ocr_verification_pass_runs_v2,public.ocr_verification_transcriptions_v2 from public,anon,authenticated,service_role;
grant select on public.ocr_verification_page_jobs_v2,public.ocr_verification_pass_runs_v2,public.ocr_verification_transcriptions_v2 to service_role;
create index ocr_verification_page_jobs_v2_status_idx on public.ocr_verification_page_jobs_v2(status,created_at);
create index ocr_verification_page_jobs_v2_freeze_idx on public.ocr_verification_page_jobs_v2(freeze_receipt_id);

create or replace function public.normalize_ocr_consensus_text_v2(p_text text)
returns text language sql immutable set search_path=pg_catalog,public
as $function$
  select lower(regexp_replace(translate(coalesce(p_text,''),'０１２３４５６７８９％，．　','0123456789%,. '),'[[:space:]。、，,.・「」『』（）()【】［］\[\]：:；;!！?？\-―ー]','','g'))
$function$;

create or replace function public.ocr_numeric_tokens_v2(p_text text)
returns text[] language sql immutable set search_path=pg_catalog,public
as $function$
  select coalesce(array_agg(distinct m[1] order by m[1]),'{}'::text[])
  from regexp_matches(translate(coalesce(p_text,''),'０１２３４５６７８９％，．','0123456789%,.'),'([0-9]+(?:[.,][0-9]+)?%?)','g') m
$function$;

revoke all on function public.normalize_ocr_consensus_text_v2(text) from public,anon,authenticated;
revoke all on function public.ocr_numeric_tokens_v2(text) from public,anon,authenticated;
grant execute on function public.normalize_ocr_consensus_text_v2(text) to service_role;
grant execute on function public.ocr_numeric_tokens_v2(text) to service_role;

create or replace function public.enqueue_ocr_verification_page_jobs_v2()
returns integer language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_count integer;
begin
  if (select source_region_gate from public.source_region_inventory_gate_v6)<>'passed' then raise exception 'ocr_verification_v2_source_regions_not_ready'; end if;
  insert into public.ocr_verification_page_jobs_v2(
    partition_job_id,freeze_receipt_id,page_identity_source_image_id,evidence_source_image_id,source_ocr_sha256,region_set_fingerprint,article_count,requires_second_pass
  )
  select rec.partition_job_id,rec.freeze_receipt_id,rec.page_identity_source_image_id,rec.evidence_source_image_id,rec.source_ocr_json_sha256,rec.region_set_fingerprint,rec.article_count,
         exists(select 1 from public.article_region_ocr_quality_v1 q join public.formal_source_grounded_articles_v6 g on g.article_id=q.article_id and g.partition_job_id=rec.partition_job_id where q.region_quality_status<>'strong')
  from public.source_region_materialization_receipts_v6 rec
  join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=rec.freeze_receipt_id
  on conflict(partition_job_id) do nothing;
  get diagnostics v_count=row_count;return v_count;
end
$function$;
revoke all on function public.enqueue_ocr_verification_page_jobs_v2() from public,anon,authenticated;
grant execute on function public.enqueue_ocr_verification_page_jobs_v2() to service_role;

create or replace function public.claim_ocr_verification_page_job_v2(p_lease_seconds integer default 240)
returns setof public.ocr_verification_page_jobs_v2 language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare v_id uuid;v_token uuid:=gen_random_uuid();
begin
  if (select source_region_gate from public.source_region_inventory_gate_v6)<>'passed' then raise exception 'ocr_verification_v2_source_regions_not_ready'; end if;
  select id into v_id from public.ocr_verification_page_jobs_v2
  where (status='queued' or (status='running' and coalesce(lease_expires_at,'epoch'::timestamptz)<now())) and failure_count<4
  order by requires_second_pass desc,created_at for update skip locked limit 1;
  if v_id is null then return; end if;
  update public.ocr_verification_page_jobs_v2 set status='running',lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(180,least(420,p_lease_seconds))),updated_at=now(),error_message=null where id=v_id;
  return query select * from public.ocr_verification_page_jobs_v2 where id=v_id;
end
$function$;

create or replace function public.get_ocr_verification_page_input_v2(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;v_articles jsonb;
begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_verification_v2_lease_invalid'; end if;
 if not exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id) then raise exception 'ocr_verification_v2_freeze_stale'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
   'article_id',g.article_id,'source_region_id',g.source_region_id,'region_quality_status',q.region_quality_status,
   'block_rects',(select jsonb_agg(jsonb_build_object('block_index',b.block_index,'x_min',b.x_min,'y_min',b.y_min,'x_max',b.x_max,'y_max',b.y_max) order by b.block_index)
                  from public.source_ocr_block_assignments_v2 a join public.source_ocr_blocks_v1 b on b.source_image_id=a.source_image_id and b.page_index=a.page_index and b.block_index=a.block_index
                  where a.source_image_id=g.evidence_source_image_id and a.article_id=g.article_id and a.assignment_kind='article' and a.assignment_version=g.block_partition_version)
 ) order by g.article_id::text),'[]'::jsonb) into v_articles
 from public.formal_source_grounded_articles_v6 g join public.article_region_ocr_quality_v1 q on q.article_id=g.article_id and q.source_region_id=g.source_region_id
 where g.partition_job_id=j.partition_job_id;
 if jsonb_array_length(v_articles)<>j.article_count then raise exception 'ocr_verification_v2_article_set_stale'; end if;
 return jsonb_build_object('job',jsonb_build_object('id',j.id,'lease_token',j.lease_token,'requires_second_pass',j.requires_second_pass,'article_count',j.article_count,'source_ocr_sha256',j.source_ocr_sha256),
   'source',(select jsonb_build_object('id',s.id,'storage_path',s.storage_path,'mime_type',s.mime_type,'width',s.width,'height',s.height,'file_name',s.file_name) from public.source_images s where s.id=j.evidence_source_image_id),
   'articles',v_articles);
end
$function$;

create or replace function public.replace_ocr_verification_pass_v2(
 p_job_id uuid,p_lease_token uuid,p_pass_kind text,p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,p_rows jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;r jsonb;v_expected integer;v_count integer;
begin
 if p_pass_kind not in ('verifier','critic') then raise exception 'ocr_verification_v2_bad_pass_kind'; end if;
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_verification_v2_lease_invalid'; end if;
 if p_pass_kind='critic' and not j.requires_second_pass then raise exception 'ocr_verification_v2_critic_not_required'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<>j.article_count then raise exception 'ocr_verification_v2_row_count_mismatch'; end if;
 if exists(select 1 from public.ocr_verification_pass_runs_v2 p where p.job_id=j.id and (p.model=p_model or p.provider_response_id=p_provider_response_id or p.prompt_sha256=p_prompt_sha256)) then raise exception 'ocr_verification_v2_independent_pass_required'; end if;
 delete from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind=p_pass_kind;
 delete from public.ocr_verification_pass_runs_v2 where job_id=j.id and pass_kind=p_pass_kind;
 insert into public.ocr_verification_pass_runs_v2(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256) values(j.id,p_pass_kind,p_model,p_provider_response_id,p_prompt_sha256,p_response_sha256);
 for r in select value from jsonb_array_elements(p_rows) loop
   if not exists(select 1 from public.formal_source_grounded_articles_v6 g where g.partition_job_id=j.partition_job_id and g.article_id=(r->>'article_id')::uuid) then raise exception 'ocr_verification_v2_unknown_article'; end if;
   if coalesce(btrim(r->>'transcription'),'')='' then raise exception 'ocr_verification_v2_empty_transcription'; end if;
   if coalesce((r->>'confidence')::numeric,0)<0.85 then raise exception 'ocr_verification_v2_low_confidence'; end if;
   if coalesce(r->>'proper_noun_status','') not in ('passed','not_applicable','failed') then raise exception 'ocr_verification_v2_bad_proper_noun_status'; end if;
   insert into public.ocr_verification_transcriptions_v2(job_id,pass_kind,article_id,transcription,transcription_sha256,confidence,proper_noun_status,visual_proper_nouns,reason)
   values(j.id,p_pass_kind,(r->>'article_id')::uuid,r->>'transcription',encode(extensions.digest(convert_to(r->>'transcription','UTF8'),'sha256'),'hex'),(r->>'confidence')::numeric,r->>'proper_noun_status',coalesce(array(select jsonb_array_elements_text(coalesce(r->'visual_proper_nouns','[]'::jsonb))),'{}'::text[]),left(coalesce(r->>'reason',''),1000));
 end loop;
 select count(*)::integer,count(distinct article_id)::integer into v_count,v_expected from public.ocr_verification_transcriptions_v2 where job_id=j.id and pass_kind=p_pass_kind;
 if v_count<>j.article_count or v_expected<>j.article_count then raise exception 'ocr_verification_v2_article_set_not_bijective'; end if;
 return jsonb_build_object('status','stored','rows',v_count,'pass_kind',p_pass_kind);
end
$function$;

create or replace function public.yield_ocr_verification_page_job_v2(p_job_id uuid,p_lease_token uuid,p_stage text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'ocr_verification_v2_lease_invalid'; end if;
 update public.ocr_verification_page_jobs_v2 set status='queued',lease_token=null,lease_expires_at=null,error_message=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','queued','completed_stage',left(coalesce(p_stage,''),100));
end
$function$;

create or replace function public.fail_ocr_verification_page_job_v2(p_job_id uuid,p_lease_token uuid,p_error text,p_retryable boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;v_next text;v_failures integer;v_structural boolean;begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'ocr_verification_v2_lease_invalid'; end if;
 v_structural:=coalesce(p_error,'') ~* '(row_count|unknown_article|empty_transcription|low_confidence|article_set|independent_pass|consensus|numeric_mismatch)';
 v_failures:=j.failure_count+1;v_next:=case when v_structural then 'needs_review' when p_retryable and v_failures<4 then 'queued' else 'failed' end;
 update public.ocr_verification_page_jobs_v2 set status=v_next,failure_count=v_failures,lease_token=null,lease_expires_at=null,error_message=left(coalesce(p_error,''),3000),updated_at=now(),finished_at=case when v_next='failed' then now() else null end where id=j.id;
 return jsonb_build_object('status',v_next,'failure_count',v_failures,'structural',v_structural);
end
$function$;

create or replace function public.finalize_ocr_verification_page_job_v2(p_job_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions
as $function$
declare j public.ocr_verification_page_jobs_v2%rowtype;v_required integer;v_bad integer;v_rows integer;v_verifier public.ocr_verification_pass_runs_v2%rowtype;
begin
 select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'ocr_verification_v2_lease_invalid'; end if;
 if not exists(select 1 from public.formal_corpus_freeze_gate_v2 fg where fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id) then raise exception 'ocr_verification_v2_freeze_stale'; end if;
 v_required:=case when j.requires_second_pass then 2 else 1 end;
 if (select count(*) from public.ocr_verification_pass_runs_v2 where job_id=j.id)<>v_required then raise exception 'ocr_verification_v2_pass_receipts_incomplete'; end if;
 select * into v_verifier from public.ocr_verification_pass_runs_v2 where job_id=j.id and pass_kind='verifier';
 with checks as (
   select g.article_id,q.region_quality_status,g.source_region_text,
          v.transcription verifier_text,v.proper_noun_status verifier_pn,
          c.transcription critic_text,c.proper_noun_status critic_pn,
          similarity(public.normalize_ocr_consensus_text_v2(g.source_region_text),public.normalize_ocr_consensus_text_v2(v.transcription)) verifier_sim,
          case when c.article_id is null then 1::real else similarity(public.normalize_ocr_consensus_text_v2(g.source_region_text),public.normalize_ocr_consensus_text_v2(c.transcription)) end critic_sim,
          case when c.article_id is null then 1::real else similarity(public.normalize_ocr_consensus_text_v2(v.transcription),public.normalize_ocr_consensus_text_v2(c.transcription)) end interpass_sim,
          public.ocr_numeric_tokens_v2(g.source_region_text)=public.ocr_numeric_tokens_v2(v.transcription) verifier_numbers,
          case when c.article_id is null then true else public.ocr_numeric_tokens_v2(g.source_region_text)=public.ocr_numeric_tokens_v2(c.transcription) end critic_numbers
   from public.formal_source_grounded_articles_v6 g
   join public.article_region_ocr_quality_v1 q on q.article_id=g.article_id and q.source_region_id=g.source_region_id
   join public.ocr_verification_transcriptions_v2 v on v.job_id=j.id and v.pass_kind='verifier' and v.article_id=g.article_id
   left join public.ocr_verification_transcriptions_v2 c on c.job_id=j.id and c.pass_kind='critic' and c.article_id=g.article_id
   where g.partition_job_id=j.partition_job_id
 )
 select count(*) filter(where verifier_sim < case when region_quality_status='strong' then 0.90 else 0.86 end
                              or critic_sim < case when region_quality_status='strong' then 0.90 else 0.86 end
                              or interpass_sim<0.90 or not verifier_numbers or not critic_numbers
                              or verifier_pn='failed' or coalesce(critic_pn,'passed')='failed')::integer,
        count(*)::integer into v_bad,v_rows from checks;
 if v_rows<>j.article_count or v_bad>0 then
   update public.ocr_verification_page_jobs_v2 set status='needs_review',lease_token=null,lease_expires_at=null,error_message=format('independent visual consensus failed: rows=%s expected=%s bad=%s',v_rows,j.article_count,v_bad),updated_at=now() where id=j.id;
   return jsonb_build_object('status','needs_review','rows',v_rows,'bad_articles',v_bad);
 end if;
 insert into public.article_ocr_verifications_v1(
   article_id,source_region_id,partition_job_id,verification_version,region_quality_status,verification_mode,canonical_text,canonical_text_sha256,
   source_region_sha256,source_ocr_sha256,numeric_verification_status,proper_noun_verification_status,
   independent_provider,independent_model,independent_response_id,independent_prompt_sha256,independent_response_sha256,quality_status,quality_reason,verified_at,updated_at
 )
 select g.article_id,g.source_region_id,g.partition_job_id,'article_ocr_verification_v2_independent_page_vision',q.region_quality_status,'independent_vision_consensus',
        g.source_region_text,g.source_region_sha256,g.source_region_sha256,g.current_source_raw_ocr_sha256,
        case when cardinality(public.ocr_numeric_tokens_v2(g.source_region_text))=0 then 'not_applicable' else 'passed' end,
        case when v.proper_noun_status='not_applicable' and (c.article_id is null or c.proper_noun_status='not_applicable') then 'not_applicable' else 'passed' end,
        'openai',v_verifier.model,v_verifier.provider_response_id,v_verifier.prompt_sha256,v_verifier.response_sha256,'passed',
        case when j.requires_second_pass then 'Google OCR region independently transcribed and confirmed by two distinct vision passes' else 'Google OCR region independently transcribed and confirmed by vision pass' end,now(),now()
 from public.formal_source_grounded_articles_v6 g
 join public.article_region_ocr_quality_v1 q on q.article_id=g.article_id and q.source_region_id=g.source_region_id
 join public.ocr_verification_transcriptions_v2 v on v.job_id=j.id and v.pass_kind='verifier' and v.article_id=g.article_id
 left join public.ocr_verification_transcriptions_v2 c on c.job_id=j.id and c.pass_kind='critic' and c.article_id=g.article_id
 where g.partition_job_id=j.partition_job_id
 on conflict(article_id) do update set source_region_id=excluded.source_region_id,partition_job_id=excluded.partition_job_id,verification_version=excluded.verification_version,region_quality_status=excluded.region_quality_status,verification_mode=excluded.verification_mode,canonical_text=excluded.canonical_text,canonical_text_sha256=excluded.canonical_text_sha256,source_region_sha256=excluded.source_region_sha256,source_ocr_sha256=excluded.source_ocr_sha256,numeric_verification_status=excluded.numeric_verification_status,proper_noun_verification_status=excluded.proper_noun_verification_status,independent_provider=excluded.independent_provider,independent_model=excluded.independent_model,independent_response_id=excluded.independent_response_id,independent_prompt_sha256=excluded.independent_prompt_sha256,independent_response_sha256=excluded.independent_response_sha256,quality_status='passed',quality_reason=excluded.quality_reason,verified_at=now(),updated_at=now();
 update public.ocr_verification_page_jobs_v2 set status='completed',lease_token=null,lease_expires_at=null,error_message=null,finished_at=now(),updated_at=now() where id=j.id;
 return jsonb_build_object('status','completed','article_count',j.article_count,'second_pass',j.requires_second_pass);
end
$function$;

revoke all on function public.enqueue_ocr_verification_page_jobs_v2() from public,anon,authenticated;
revoke all on function public.claim_ocr_verification_page_job_v2(integer) from public,anon,authenticated;
revoke all on function public.get_ocr_verification_page_input_v2(uuid,uuid) from public,anon,authenticated;
revoke all on function public.replace_ocr_verification_pass_v2(uuid,uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.yield_ocr_verification_page_job_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.fail_ocr_verification_page_job_v2(uuid,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.finalize_ocr_verification_page_job_v2(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_ocr_verification_page_jobs_v2() to service_role;
grant execute on function public.claim_ocr_verification_page_job_v2(integer) to service_role;
grant execute on function public.get_ocr_verification_page_input_v2(uuid,uuid) to service_role;
grant execute on function public.replace_ocr_verification_pass_v2(uuid,uuid,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.yield_ocr_verification_page_job_v2(uuid,uuid,text) to service_role;
grant execute on function public.fail_ocr_verification_page_job_v2(uuid,uuid,text,boolean) to service_role;
grant execute on function public.finalize_ocr_verification_page_job_v2(uuid,uuid) to service_role;

create or replace view public.ocr_verification_gate_v2
with (security_invoker=true)
as
with expected as (select expected_page_count page_count,expected_article_count article_count from public.source_region_inventory_gate_v6),jobs as (
 select count(*)::integer jobs,count(*) filter(where status='completed')::integer completed,count(*) filter(where status='needs_review')::integer needs_review,count(*) filter(where status='failed')::integer failed from public.ocr_verification_page_jobs_v2 j join public.formal_corpus_freeze_gate_v2 fg on fg.freeze_gate_v2='passed' and fg.freeze_receipt_id=j.freeze_receipt_id
),ver as (select count(*)::integer verified from public.formal_source_grounded_articles_v5)
select expected.page_count expected_pages,expected.article_count expected_articles,jobs.jobs,jobs.completed,jobs.needs_review,jobs.failed,ver.verified,
 case when jobs.needs_review>0 or jobs.failed>0 then 'failed' when jobs.jobs<>expected.page_count or jobs.completed<>expected.page_count or ver.verified<>expected.article_count then 'pending' else 'passed' end ocr_verification_gate
from expected cross join jobs cross join ver;
revoke all on public.ocr_verification_gate_v2 from public,anon,authenticated;
grant select on public.ocr_verification_gate_v2 to service_role;

commit;
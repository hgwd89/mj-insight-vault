create or replace function public.renew_article_embedding_job_lease_v4(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 300)
returns timestamptz language plpgsql security definer set search_path=pg_catalog,public as $$declare v timestamptz;begin
 update public.article_embedding_jobs_v4 set lease_expires_at=now()+make_interval(secs=>greatest(120,least(600,coalesce(p_lease_seconds,300)))),updated_at=now()
 where id=p_job_id and status='running' and lease_token=p_lease_token and lease_expires_at>=now() returning lease_expires_at into v;
 if v is null then raise exception 'embedding_v4_job_lease_invalid'; end if; return v;end$$;

create or replace function public.renew_article_classification_job_lease_v4(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 300)
returns timestamptz language plpgsql security definer set search_path=pg_catalog,public as $$declare v timestamptz;begin
 update public.article_classification_jobs_v4 set lease_expires_at=now()+make_interval(secs=>greatest(120,least(600,coalesce(p_lease_seconds,300)))),updated_at=now()
 where id=p_job_id and status='running' and lease_token=p_lease_token and lease_expires_at>=now() returning lease_expires_at into v;
 if v is null then raise exception 'classification_v4_job_lease_invalid'; end if; return v;end$$;

create or replace function public.renew_full_corpus_review_job_lease_v5(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 420)
returns timestamptz language plpgsql security definer set search_path=pg_catalog,public as $$declare v timestamptz;begin
 update public.full_corpus_review_jobs_v5 set lease_expires_at=now()+make_interval(secs=>greatest(180,least(900,coalesce(p_lease_seconds,420)))),updated_at=now()
 where id=p_job_id and status='running' and lease_token=p_lease_token and lease_expires_at>=now() returning lease_expires_at into v;
 if v is null then raise exception 'review_v5_job_lease_invalid'; end if; return v;end$$;

create or replace function public.renew_theme_candidate_synthesis_job_lease_v5(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 600)
returns timestamptz language plpgsql security definer set search_path=pg_catalog,public as $$declare v timestamptz;begin
 update public.theme_candidate_synthesis_jobs_v5 set lease_expires_at=now()+make_interval(secs=>greatest(180,least(1200,coalesce(p_lease_seconds,600)))),updated_at=now()
 where id=p_job_id and status='running' and lease_token=p_lease_token and lease_expires_at>=now() returning lease_expires_at into v;
 if v is null then raise exception 'theme_synthesis_v5_lease_invalid'; end if; return v;end$$;

create or replace function public.renew_theme_seed_mapping_job_lease_v5(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 420)
returns timestamptz language plpgsql security definer set search_path=pg_catalog,public as $$declare v timestamptz;begin
 update public.theme_seed_mapping_jobs_v5 set lease_expires_at=now()+make_interval(secs=>greatest(180,least(900,coalesce(p_lease_seconds,420)))),updated_at=now()
 where id=p_job_id and status='running' and lease_token=p_lease_token and lease_expires_at>=now() returning lease_expires_at into v;
 if v is null then raise exception 'seed_mapping_v5_lease_invalid'; end if; return v;end$$;

create or replace function public.renew_theme_census_batch_lease_v5(p_batch_id uuid,p_lease_token uuid,p_lease_seconds integer default 420)
returns timestamptz language plpgsql security definer set search_path=pg_catalog,public as $$declare v timestamptz;begin
 update public.theme_census_batches_v4 set lease_expires_at=now()+make_interval(secs=>greatest(180,least(900,coalesce(p_lease_seconds,420)))),updated_at=now()
 where id=p_batch_id and status='running' and lease_token=p_lease_token and lease_expires_at>=now() returning lease_expires_at into v;
 if v is null then raise exception 'census_v5_lease_invalid'; end if; return v;end$$;

create or replace function public.renew_formal_report_job_lease_v6(p_job_id uuid,p_lease_token uuid,p_lease_seconds integer default 420)
returns timestamptz language plpgsql security definer set search_path=pg_catalog,public as $$declare v timestamptz;begin
 update public.formal_report_jobs_v6 set lease_expires_at=now()+make_interval(secs=>greatest(180,least(900,coalesce(p_lease_seconds,420)))),updated_at=now()
 where id=p_job_id and status='running' and lease_token=p_lease_token and lease_expires_at>=now() returning lease_expires_at into v;
 if v is null then raise exception 'report_v6_lease_invalid'; end if; return v;end$$;

create or replace function public.fail_theme_candidate_synthesis_job_v5(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare j public.theme_candidate_synthesis_jobs_v5%rowtype;v_retry boolean;v_delay integer;begin
 select * into j from public.theme_candidate_synthesis_jobs_v5 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'theme_synthesis_v5_lease_invalid';end if;
 v_retry:=coalesce(p_retryable,true) and j.attempt_count<4;v_delay:=least(1200,60*(2^greatest(0,j.attempt_count-1))::integer);
 update public.theme_candidate_synthesis_jobs_v5 set status=case when v_retry then 'queued' else 'failed' end,last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),error_message=left(coalesce(p_error_message,'theme synthesis failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,finished_at=case when v_retry then null else now() end,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',j.attempt_count);end$$;

create or replace function public.fail_theme_seed_mapping_job_v5(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare j public.theme_seed_mapping_jobs_v5%rowtype;v_retry boolean;v_delay integer;begin
 select * into j from public.theme_seed_mapping_jobs_v5 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'seed_mapping_v5_lease_invalid';end if;
 v_retry:=coalesce(p_retryable,true) and j.attempt_count<4;v_delay:=least(900,45*(2^greatest(0,j.attempt_count-1))::integer);
 update public.theme_seed_mapping_jobs_v5 set status=case when v_retry then 'queued' else 'failed' end,last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),error_message=left(coalesce(p_error_message,'seed mapping failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,finished_at=case when v_retry then null else now() end,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',j.attempt_count);end$$;

create or replace function public.fail_theme_census_batch_v5(p_batch_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare b public.theme_census_batches_v4%rowtype;v_retry boolean;v_delay integer;begin
 select * into b from public.theme_census_batches_v4 where id=p_batch_id for update;if not found or b.status<>'running' or b.lease_token is distinct from p_lease_token then raise exception 'census_v5_lease_invalid';end if;
 v_retry:=coalesce(p_retryable,true) and b.attempt_count<4;v_delay:=least(900,45*(2^greatest(0,b.attempt_count-1))::integer);
 update public.theme_census_batches_v4 set status=case when v_retry then 'queued' else 'failed' end,last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),error_message=left(coalesce(p_error_message,'census failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,finished_at=case when v_retry then null else now() end,lease_token=null,lease_expires_at=null,updated_at=now() where id=b.id;
 if not v_retry then update public.theme_analysis_runs_v4 set status='failed',error_message=left(coalesce(p_error_message,'census failed'),2000),updated_at=now() where id=b.analysis_run_id; end if;
 return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',b.attempt_count);end$$;

create or replace function public.fail_formal_report_job_v6(p_job_id uuid,p_lease_token uuid,p_error_message text,p_retryable boolean default true,p_error_class text default 'worker_error')
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare j public.formal_report_jobs_v6%rowtype;v_retry boolean;v_delay integer;begin
 select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token then raise exception 'report_v6_lease_invalid';end if;
 v_retry:=coalesce(p_retryable,true) and j.attempt_count<4;v_delay:=least(900,45*(2^greatest(0,j.attempt_count-1))::integer);
 update public.formal_report_jobs_v6 set status=case when v_retry then 'queued' else 'failed' end,last_error_class=coalesce(nullif(p_error_class,''),'worker_error'),error_message=left(coalesce(p_error_message,'report worker failed'),2000),next_retry_at=case when v_retry then now()+make_interval(secs=>v_delay) else null end,finished_at=case when v_retry then null else now() end,lease_token=null,lease_expires_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status',case when v_retry then 'queued' else 'failed' end,'retry_scheduled',v_retry,'attempt_count',j.attempt_count);end$$;

create or replace function public.requeue_theme_candidate_synthesis_job_v5(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare j public.theme_candidate_synthesis_jobs_v5%rowtype;begin
 select * into j from public.theme_candidate_synthesis_jobs_v5 where id=p_job_id for update;if not found or j.status not in ('needs_review','failed') then raise exception 'theme_synthesis_v5_not_requeueable';end if;
 if exists(select 1 from public.theme_candidates_v4 where analysis_run_id=j.analysis_run_id) then raise exception 'theme_synthesis_v5_candidates_already_finalized';end if;
 delete from public.theme_candidate_critic_rows_v5 where job_id=j.id;delete from public.theme_candidate_proposals_v5 where job_id=j.id;delete from public.theme_candidate_synthesis_pass_runs_v5 where job_id=j.id;
 update public.theme_candidate_synthesis_jobs_v5 set status='queued',attempt_count=0,lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,started_at=null,finished_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','queued');end$$;

create or replace function public.requeue_theme_seed_mapping_job_v5(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare j public.theme_seed_mapping_jobs_v5%rowtype;begin
 select * into j from public.theme_seed_mapping_jobs_v5 where id=p_job_id for update;if not found or j.status not in ('needs_review','failed') then raise exception 'seed_mapping_v5_not_requeueable';end if;
 if exists(select 1 from public.theme_seed_mappings_v4 m where m.analysis_run_id=j.analysis_run_id and m.seed_id=any(j.seed_ids)) then raise exception 'seed_mapping_v5_already_finalized';end if;
 delete from public.theme_seed_mapping_stage_v5 where job_id=j.id;delete from public.theme_seed_mapping_pass_runs_v5 where job_id=j.id;
 update public.theme_seed_mapping_jobs_v5 set status='queued',attempt_count=0,lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,started_at=null,finished_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','queued');end$$;

create or replace function public.requeue_theme_census_batch_v5(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare b public.theme_census_batches_v4%rowtype;begin
 select * into b from public.theme_census_batches_v4 where id=p_batch_id for update;if not found or b.status not in ('needs_review','failed') then raise exception 'census_v5_not_requeueable';end if;
 if not exists(select 1 from public.theme_analysis_runs_v4 a where a.id=b.analysis_run_id and a.candidate_set_fingerprint=b.candidate_set_fingerprint and public.full_corpus_run_integrity_v5(a.scan_run_id)) then raise exception 'census_v5_upstream_stale';end if;
 delete from public.theme_census_relations_v4 where census_batch_id=b.id;delete from public.theme_census_stage_v5 where census_batch_id=b.id;delete from public.theme_census_pass_runs_v5 where census_batch_id=b.id;
 update public.theme_census_batches_v4 set status='queued',attempt_count=0,lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,started_at=null,finished_at=null,updated_at=now() where id=b.id;
 update public.theme_analysis_runs_v4 set status='census_queued',error_message=null,updated_at=now() where id=b.analysis_run_id and status in ('needs_review','failed');
 return jsonb_build_object('status','queued');end$$;

create or replace function public.requeue_formal_report_job_v6(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$declare j public.formal_report_jobs_v6%rowtype;begin
 select * into j from public.formal_report_jobs_v6 where id=p_job_id for update;if not found or j.status not in ('needs_review','failed') or j.report_id is not null then raise exception 'report_v6_not_requeueable';end if;
 if not public.strict_analysis_prerequisites_pass_v7(j.analysis_run_id) then raise exception 'report_v6_upstream_stale';end if;
 delete from public.formal_report_critic_rows_v6 where report_job_id=j.id;delete from public.formal_report_claims_v6 where report_job_id=j.id;delete from public.formal_report_pass_runs_v6 where report_job_id=j.id;
 update public.formal_report_jobs_v6 set status='queued',attempt_count=0,lease_token=null,lease_expires_at=null,next_retry_at=null,last_error_class=null,error_message=null,started_at=null,finished_at=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','queued');end$$;

revoke execute on function public.renew_article_embedding_job_lease_v4(uuid,uuid,integer),public.renew_article_classification_job_lease_v4(uuid,uuid,integer),public.renew_full_corpus_review_job_lease_v5(uuid,uuid,integer),public.renew_theme_candidate_synthesis_job_lease_v5(uuid,uuid,integer),public.renew_theme_seed_mapping_job_lease_v5(uuid,uuid,integer),public.renew_theme_census_batch_lease_v5(uuid,uuid,integer),public.renew_formal_report_job_lease_v6(uuid,uuid,integer),public.fail_theme_candidate_synthesis_job_v5(uuid,uuid,text,boolean,text),public.fail_theme_seed_mapping_job_v5(uuid,uuid,text,boolean,text),public.fail_theme_census_batch_v5(uuid,uuid,text,boolean,text),public.fail_formal_report_job_v6(uuid,uuid,text,boolean,text),public.requeue_theme_candidate_synthesis_job_v5(uuid),public.requeue_theme_seed_mapping_job_v5(uuid),public.requeue_theme_census_batch_v5(uuid),public.requeue_formal_report_job_v6(uuid) from public,anon,authenticated;
grant execute on function public.renew_article_embedding_job_lease_v4(uuid,uuid,integer),public.renew_article_classification_job_lease_v4(uuid,uuid,integer),public.renew_full_corpus_review_job_lease_v5(uuid,uuid,integer),public.renew_theme_candidate_synthesis_job_lease_v5(uuid,uuid,integer),public.renew_theme_seed_mapping_job_lease_v5(uuid,uuid,integer),public.renew_theme_census_batch_lease_v5(uuid,uuid,integer),public.renew_formal_report_job_lease_v6(uuid,uuid,integer),public.fail_theme_candidate_synthesis_job_v5(uuid,uuid,text,boolean,text),public.fail_theme_seed_mapping_job_v5(uuid,uuid,text,boolean,text),public.fail_theme_census_batch_v5(uuid,uuid,text,boolean,text),public.fail_formal_report_job_v6(uuid,uuid,text,boolean,text),public.requeue_theme_candidate_synthesis_job_v5(uuid),public.requeue_theme_seed_mapping_job_v5(uuid),public.requeue_theme_census_batch_v5(uuid),public.requeue_formal_report_job_v6(uuid) to service_role;
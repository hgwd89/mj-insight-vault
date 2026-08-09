create table public.article_source_grounding_pass_runs_v3 (
  job_id uuid primary key references public.source_page_partition_jobs_v3(id) on delete cascade,
  model text not null,
  provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.replace_article_source_grounding_reviews_v4(
  p_job_id uuid,p_lease_token uuid,
  p_model text,p_provider_response_id text,p_prompt_sha256 text,p_response_sha256 text,
  p_rows jsonb
)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_mapper public.source_page_partition_pass_runs_v3%rowtype;
  v_critic public.source_page_partition_pass_runs_v3%rowtype;
  v_result jsonb;
begin
  select * into v_mapper from public.source_page_partition_pass_runs_v3 where job_id=p_job_id and pass_kind='mapper';
  select * into v_critic from public.source_page_partition_pass_runs_v3 where job_id=p_job_id and pass_kind='critic';
  if v_mapper.job_id is null or v_critic.job_id is null then raise exception 'grounding_v4_partition_pass_receipts_required'; end if;
  if coalesce(btrim(p_model),'')='' or p_model in (v_mapper.model,v_critic.model) then raise exception 'grounding_v4_third_model_required'; end if;
  if coalesce(btrim(p_provider_response_id),'')='' or p_provider_response_id in (v_mapper.provider_response_id,v_critic.provider_response_id) then raise exception 'grounding_v4_distinct_response_id_required'; end if;
  if p_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_response_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'grounding_v4_hash_receipts_required'; end if;
  if p_prompt_sha256 in (v_mapper.prompt_sha256,v_critic.prompt_sha256) then raise exception 'grounding_v4_prompt_must_be_distinct'; end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(article_id uuid,grounding_decision text,shared_terms text[],reason text,grounding_model text) where coalesce(x.grounding_model,'')<>p_model) then raise exception 'grounding_v4_row_model_mismatch'; end if;

  insert into public.article_source_grounding_pass_runs_v3(job_id,model,provider_response_id,prompt_sha256,response_sha256,updated_at)
  values(p_job_id,left(p_model,200),left(p_provider_response_id,300),p_prompt_sha256,p_response_sha256,now())
  on conflict(job_id) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();

  v_result:=public.replace_article_source_grounding_reviews_v3(p_job_id,p_lease_token,p_rows);
  return v_result||jsonb_build_object('grounding_model',p_model,'grounding_response_id',p_provider_response_id);
end $$;

alter table public.article_source_grounding_pass_runs_v3 enable row level security;
revoke all on table public.article_source_grounding_pass_runs_v3 from anon,authenticated;
grant all on table public.article_source_grounding_pass_runs_v3 to service_role;
revoke execute on function public.replace_article_source_grounding_reviews_v3(uuid,uuid,jsonb) from service_role;
revoke execute on function public.replace_article_source_grounding_reviews_v4(uuid,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.replace_article_source_grounding_reviews_v4(uuid,uuid,text,text,text,text,jsonb) to service_role;
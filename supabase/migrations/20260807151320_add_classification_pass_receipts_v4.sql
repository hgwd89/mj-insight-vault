create table public.article_classification_pass_runs_v4 (
  job_id uuid not null references public.article_classification_jobs_v4(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('classifier','critic')),
  model text not null,
  provider_response_id text not null,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(job_id,pass_kind),
  unique(provider_response_id)
);

create function public.complete_article_classification_job_v5(
  p_job_id uuid,p_lease_token uuid,
  p_classifier_model text,p_classifier_response_id text,p_classifier_prompt_sha256 text,p_classifier_response_sha256 text,
  p_critic_model text,p_critic_response_id text,p_critic_prompt_sha256 text,p_critic_response_sha256 text,
  p_classifier jsonb,p_critic jsonb
)
returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_result jsonb;begin
  if coalesce(btrim(p_classifier_model),'')='' or coalesce(btrim(p_critic_model),'')='' then raise exception 'classification_v5_models_required'; end if;
  if p_classifier_model=p_critic_model then raise exception 'classification_v5_models_must_differ'; end if;
  if coalesce(btrim(p_classifier_response_id),'')='' or coalesce(btrim(p_critic_response_id),'')='' or p_classifier_response_id=p_critic_response_id then raise exception 'classification_v5_distinct_response_ids_required'; end if;
  if p_classifier_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_classifier_response_sha256 !~ '^[0-9a-f]{64}$' or p_critic_prompt_sha256 !~ '^[0-9a-f]{64}$' or p_critic_response_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'classification_v5_hash_receipts_required'; end if;
  if p_classifier_prompt_sha256=p_critic_prompt_sha256 then raise exception 'classification_v5_prompts_must_differ'; end if;

  insert into public.article_classification_pass_runs_v4(job_id,pass_kind,model,provider_response_id,prompt_sha256,response_sha256,updated_at)
  values
    (p_job_id,'classifier',left(p_classifier_model,200),left(p_classifier_response_id,300),p_classifier_prompt_sha256,p_classifier_response_sha256,now()),
    (p_job_id,'critic',left(p_critic_model,200),left(p_critic_response_id,300),p_critic_prompt_sha256,p_critic_response_sha256,now())
  on conflict(job_id,pass_kind) do update set model=excluded.model,provider_response_id=excluded.provider_response_id,prompt_sha256=excluded.prompt_sha256,response_sha256=excluded.response_sha256,updated_at=now();

  v_result:=public.complete_article_classification_job_v4(p_job_id,p_lease_token,p_classifier_model,p_critic_model,p_classifier,p_critic);
  return v_result||jsonb_build_object('classifier_response_id',p_classifier_response_id,'critic_response_id',p_critic_response_id);
end $$;

alter table public.article_classification_pass_runs_v4 enable row level security;
revoke all on table public.article_classification_pass_runs_v4 from anon,authenticated;
grant all on table public.article_classification_pass_runs_v4 to service_role;
revoke execute on function public.complete_article_classification_job_v4(uuid,uuid,text,text,jsonb,jsonb) from service_role;
revoke execute on function public.complete_article_classification_job_v5(uuid,uuid,text,text,text,text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.complete_article_classification_job_v5(uuid,uuid,text,text,text,text,text,text,text,text,jsonb,jsonb) to service_role;
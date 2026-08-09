begin;

create table public.verified_article_review_jobs_v6(
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  classification_receipt_id uuid not null references public.category_classification_corpus_receipts_v7(id) on delete cascade,
  verified_text_sha256 text not null check(verified_text_sha256 ~ '^[0-9a-f]{64}$'),
  review_input_sha256 text not null check(review_input_sha256 ~ '^[0-9a-f]{64}$'),
  review_version text not null default 'verified_article_review_v6',
  status text not null default 'queued' check(status in ('queued','running','needs_review','completed','failed')),
  active_pass_kind text check(active_pass_kind is null or active_pass_kind in ('reviewer','critic')),
  failure_count integer not null default 0 check(failure_count>=0),
  lease_token uuid,lease_expires_at timestamptz,error_message text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),finished_at timestamptz,
  unique(article_id,classification_receipt_id,review_version,review_input_sha256)
);
create table public.verified_article_review_passes_v6(
  job_id uuid not null references public.verified_article_review_jobs_v6(id) on delete cascade,
  pass_kind text not null check(pass_kind in ('reviewer','critic')),
  model text not null,provider_response_id text not null unique,
  prompt_sha256 text not null check(prompt_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text not null check(response_sha256 ~ '^[0-9a-f]{64}$'),
  result_json jsonb not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  primary key(job_id,pass_kind)
);
create table public.verified_article_reviews_v6(
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.verified_article_review_jobs_v6(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  classification_receipt_id uuid not null references public.category_classification_corpus_receipts_v7(id) on delete cascade,
  verified_text_sha256 text not null check(verified_text_sha256 ~ '^[0-9a-f]{64}$'),
  review_input_sha256 text not null check(review_input_sha256 ~ '^[0-9a-f]{64}$'),
  subject text not null,measurement text not null,consumer_relevance text not null,
  observed_fact text not null,limitation text not null,no_theme_signal boolean not null,no_theme_signal_reason text,
  observed_fact_anchor text not null,reviewer_model text not null,critic_model text not null,review_version text not null,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(article_id,classification_receipt_id,review_version,review_input_sha256)
);
create table public.verified_article_review_anchors_v6(
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.verified_article_reviews_v6(id) on delete cascade,
  anchor_slot text not null,anchor_text text not null,anchor_position integer not null check(anchor_position>0),
  created_at timestamptz not null default now(),unique(review_id,anchor_slot)
);
create table public.verified_article_theme_seeds_v6(
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.verified_article_reviews_v6(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  seed_label text not null,seed_statement text not null,subject text not null,measurement text not null,
  confidence numeric not null check(confidence between 0 and 1),source_anchor text not null,
  created_at timestamptz not null default now()
);

alter table public.verified_article_review_jobs_v6 enable row level security;
alter table public.verified_article_review_passes_v6 enable row level security;
alter table public.verified_article_reviews_v6 enable row level security;
alter table public.verified_article_review_anchors_v6 enable row level security;
alter table public.verified_article_theme_seeds_v6 enable row level security;
revoke all on public.verified_article_review_jobs_v6,public.verified_article_review_passes_v6,public.verified_article_reviews_v6,public.verified_article_review_anchors_v6,public.verified_article_theme_seeds_v6 from public,anon,authenticated,service_role;
grant select on public.verified_article_review_jobs_v6,public.verified_article_review_passes_v6,public.verified_article_reviews_v6,public.verified_article_review_anchors_v6,public.verified_article_theme_seeds_v6 to service_role;
create index verified_article_review_jobs_v6_status_idx on public.verified_article_review_jobs_v6(status,created_at);
create index verified_article_review_jobs_v6_receipt_idx on public.verified_article_review_jobs_v6(classification_receipt_id,status);
create index verified_article_theme_seeds_v6_article_idx on public.verified_article_theme_seeds_v6(article_id);

create or replace function public.verified_review_anchor_position_v6(p_article_id uuid,p_anchor text)
returns integer
language sql stable security definer set search_path=pg_catalog,public
as $function$
  select nullif(position(lower(btrim(p_anchor)) in lower(v.analysis_text)),0)
  from public.formal_verified_article_text_v5 v where v.article_id=p_article_id;
$function$;

create or replace function public.validate_verified_reviewer_json_v6(p_article_id uuid,p_json jsonb)
returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public
as $function$
declare v_text text;v_len integer;v_subject text;v_measurement text;v_fact text;v_anchor text;v_limit text;v_relevance text;v_no boolean;v_no_reason text;v_expected integer;v_count integer;v_seed_count integer;
begin
  if jsonb_typeof(p_json)<>'object' then raise exception 'verified_review_v6_row_must_be_object'; end if;
  select analysis_text into v_text from public.formal_verified_article_text_v5 where article_id=p_article_id;
  if coalesce(v_text,'')='' then raise exception 'verified_review_v6_text_missing'; end if;
  v_len:=char_length(v_text);
  v_subject:=p_json->>'subject';v_measurement:=p_json->>'measurement';v_fact:=btrim(coalesce(p_json->>'observed_fact',''));v_anchor:=btrim(coalesce(p_json->>'observed_fact_anchor',''));
  v_limit:=btrim(coalesce(p_json->>'limitation',''));v_relevance:=btrim(coalesce(p_json->>'consumer_relevance',''));v_no:=coalesce((p_json->>'no_theme_signal')::boolean,false);v_no_reason:=btrim(coalesce(p_json->>'no_theme_signal_reason',''));
  if v_subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear') then raise exception 'verified_review_v6_subject_invalid'; end if;
  if v_measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other') then raise exception 'verified_review_v6_measurement_invalid'; end if;
  if char_length(v_fact)<8 or char_length(v_anchor)<6 or public.verified_review_anchor_position_v6(p_article_id,v_anchor) is null then raise exception 'verified_review_v6_observed_fact_not_grounded'; end if;
  if char_length(v_limit)<4 or char_length(v_relevance)<2 then raise exception 'verified_review_v6_limitation_or_relevance_missing'; end if;
  if v_no and char_length(v_no_reason)<8 then raise exception 'verified_review_v6_no_theme_reason_required'; end if;
  v_expected:=case when v_len<400 then 1 when v_len<1200 then 2 else 3 end;
  select count(*)::integer,count(distinct anchor_text)::integer into v_count,v_seed_count from jsonb_to_recordset(coalesce(p_json->'coverage_anchors','[]'::jsonb)) a(anchor_text text);
  if v_count<>v_expected or v_seed_count<>v_expected then raise exception 'verified_review_v6_coverage_anchor_count_invalid'; end if;
  if exists(select 1 from jsonb_to_recordset(coalesce(p_json->'coverage_anchors','[]'::jsonb)) a(anchor_text text) where char_length(btrim(coalesce(a.anchor_text,'')))<6 or public.verified_review_anchor_position_v6(p_article_id,a.anchor_text) is null) then raise exception 'verified_review_v6_coverage_anchor_not_grounded'; end if;
  if v_expected=2 and not (
    exists(select 1 from jsonb_to_recordset(p_json->'coverage_anchors') a(anchor_text text) where public.verified_review_anchor_position_v6(p_article_id,a.anchor_text)<=v_len/2)
    and exists(select 1 from jsonb_to_recordset(p_json->'coverage_anchors') a(anchor_text text) where public.verified_review_anchor_position_v6(p_article_id,a.anchor_text)>v_len/2)
  ) then raise exception 'verified_review_v6_coverage_halves_incomplete'; end if;
  if v_expected=3 and not (
    exists(select 1 from jsonb_to_recordset(p_json->'coverage_anchors') a(anchor_text text) where public.verified_review_anchor_position_v6(p_article_id,a.anchor_text)<=v_len/3)
    and exists(select 1 from jsonb_to_recordset(p_json->'coverage_anchors') a(anchor_text text) where public.verified_review_anchor_position_v6(p_article_id,a.anchor_text)>v_len/3 and public.verified_review_anchor_position_v6(p_article_id,a.anchor_text)<=2*v_len/3)
    and exists(select 1 from jsonb_to_recordset(p_json->'coverage_anchors') a(anchor_text text) where public.verified_review_anchor_position_v6(p_article_id,a.anchor_text)>2*v_len/3)
  ) then raise exception 'verified_review_v6_coverage_thirds_incomplete'; end if;
  select count(*)::integer into v_seed_count from jsonb_array_elements(coalesce(p_json->'theme_seeds','[]'::jsonb));
  if v_no and v_seed_count<>0 then raise exception 'verified_review_v6_no_theme_must_have_zero_seeds'; end if;
  if not v_no and v_seed_count<1 then raise exception 'verified_review_v6_theme_signal_requires_seed'; end if;
  if exists(select 1 from jsonb_to_recordset(coalesce(p_json->'theme_seeds','[]'::jsonb)) s(seed_label text,seed_statement text,subject text,measurement text,confidence numeric,source_anchor text)
            where char_length(btrim(coalesce(s.seed_label,'')))<2 or char_length(btrim(coalesce(s.seed_statement,'')))<8
               or s.subject not in ('consumer','company','market','expert','regulator','worker','mixed','unclear')
               or s.measurement not in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')
               or coalesce(s.confidence,-1)<0 or coalesce(s.confidence,-1)>1 or char_length(btrim(coalesce(s.source_anchor,'')))<6
               or public.verified_review_anchor_position_v6(p_article_id,s.source_anchor) is null) then raise exception 'verified_review_v6_theme_seed_invalid'; end if;
  return true;
end
$function$;

revoke all on function public.verified_review_anchor_position_v6(uuid,text) from public,anon,authenticated;
revoke all on function public.validate_verified_reviewer_json_v6(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.verified_review_anchor_position_v6(uuid,text) to service_role;
grant execute on function public.validate_verified_reviewer_json_v6(uuid,jsonb) to service_role;

commit;
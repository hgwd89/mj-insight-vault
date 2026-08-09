alter table public.full_corpus_scan_runs
  add column if not exists source_truth_fingerprint text,
  add column if not exists source_grounded_fingerprint text,
  add column if not exists analysis_contract_version text;

create table if not exists public.article_source_region_jobs_v1 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  region_version text not null default 'source_region_v1_layout_ocr',
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  source_clean_body_sha256 text not null,
  source_image_raw_ocr_sha256 text not null,
  attempt_count integer not null default 0 check(attempt_count>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_class text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(article_id,region_version)
);

create table if not exists public.article_embedding_jobs_v2 (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  embedding_version text not null default 'article_semantic_clean_v2',
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  source_clean_body_sha256 text not null,
  embedding_input_sha256 text not null,
  attempt_count integer not null default 0 check(attempt_count>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_class text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(article_id,embedding_version)
);

create table if not exists public.full_corpus_article_reviews_v4 (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.full_corpus_scan_runs(id) on delete cascade,
  batch_id uuid not null references public.full_corpus_scan_batches(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete restrict,
  source_region_id uuid not null references public.article_source_regions(id) on delete restrict,
  batch_index integer not null check(batch_index>0),
  source_clean_body_sha256 text not null,
  source_region_sha256 text not null,
  source_image_raw_ocr_sha256 text not null,
  subject text not null check(subject in ('consumer','company','market','expert','regulator','worker','mixed','unclear')),
  measurement text not null check(measurement in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')),
  consumer_relevance text not null check(consumer_relevance in ('direct','indirect','none','unclear')),
  observed_fact text not null default '',
  limitation text not null default '',
  no_theme_signal boolean not null default false,
  no_theme_signal_reason text,
  review_model text not null,
  review_version text not null default 'article_review_v4_source_grounded',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id,article_id),
  check((no_theme_signal=false) or length(btrim(coalesce(no_theme_signal_reason,'')))>=8)
);

create table if not exists public.full_corpus_article_review_anchors_v4 (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.full_corpus_article_reviews_v4(id) on delete cascade,
  source_kind text not null check(source_kind in ('clean_body','source_region')),
  anchor_slot text not null check(anchor_slot in ('start','middle','end')),
  anchor_text text not null,
  created_at timestamptz not null default now(),
  unique(review_id,source_kind,anchor_slot),
  check(length(btrim(anchor_text))>=6)
);

create table if not exists public.full_corpus_theme_seeds_v4 (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.full_corpus_scan_runs(id) on delete cascade,
  review_id uuid not null references public.full_corpus_article_reviews_v4(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete restrict,
  seed_label text not null,
  seed_statement text not null,
  source_anchor text not null,
  source_clean_body_sha256 text not null,
  source_region_sha256 text not null,
  subject text not null check(subject in ('consumer','company','market','expert','regulator','worker','mixed','unclear')),
  measurement text not null check(measurement in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')),
  confidence numeric not null check(confidence>=0 and confidence<=1),
  seed_version text not null default 'theme_seed_v4_source_grounded',
  created_at timestamptz not null default now(),
  check(length(btrim(seed_label))>=2),
  check(length(btrim(seed_statement))>=8),
  check(length(btrim(source_anchor))>=6)
);

create table if not exists public.theme_analysis_runs_v4 (
  id uuid primary key default gen_random_uuid(),
  scan_run_id uuid not null references public.full_corpus_scan_runs(id) on delete restrict,
  scope_type text not null check(scope_type in ('all','category')),
  scope_query text,
  status text not null default 'discovering' check(status in ('discovering','mapping_seeds','census_queued','census_running','census_completed','ranked','completed','needs_review','failed')),
  source_truth_fingerprint text not null,
  source_grounded_fingerprint text not null,
  expected_article_count integer not null check(expected_article_count>0),
  expected_seed_count integer not null default 0 check(expected_seed_count>=0),
  candidate_set_fingerprint text,
  candidate_set_locked_at timestamptz,
  census_started_at timestamptz,
  census_completed_at timestamptz,
  ranking_version text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(scan_run_id)
);

create table if not exists public.theme_candidates_v4 (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  theme_key text not null,
  title text not null,
  definition text not null,
  inclusion_rule text not null,
  exclusion_rule text not null,
  discovery_method text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(analysis_run_id,theme_key),
  check(theme_key ~ '^T[0-9]{2,}$'),
  check(length(btrim(title))>=4),
  check(length(btrim(definition))>=12),
  check(length(btrim(inclusion_rule))>=8),
  check(length(btrim(exclusion_rule))>=8)
);

create table if not exists public.theme_seed_mappings_v4 (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  seed_id uuid not null references public.full_corpus_theme_seeds_v4(id) on delete cascade,
  disposition text not null check(disposition in ('mapped','rejected')),
  candidate_id uuid references public.theme_candidates_v4(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  unique(analysis_run_id,seed_id),
  check(length(btrim(reason))>=6),
  check((disposition='mapped' and candidate_id is not null) or (disposition='rejected' and candidate_id is null))
);

create table if not exists public.theme_census_batches_v4 (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  batch_index integer not null check(batch_index>0),
  article_ids uuid[] not null,
  article_count integer not null check(article_count>0),
  candidate_set_fingerprint text not null,
  status text not null default 'queued' check(status in ('queued','running','completed','needs_review','failed')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_error_class text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(analysis_run_id,batch_index),
  check(cardinality(article_ids)=article_count)
);

create table if not exists public.theme_census_relations_v4 (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.theme_analysis_runs_v4(id) on delete cascade,
  census_batch_id uuid not null references public.theme_census_batches_v4(id) on delete cascade,
  candidate_id uuid not null references public.theme_candidates_v4(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete restrict,
  relation text not null check(relation in ('support','counter','related_not_supporting','none')),
  subject text check(subject in ('consumer','company','market','expert','regulator','worker','mixed','unclear')),
  measurement text check(measurement in ('survey','purchase','usage','consumer_quote','observation','sales','market_data','launch','announcement','operational_change','financial_result','forecast','experiment','other')),
  clean_body_anchor text,
  source_region_anchor text,
  rationale text not null,
  confidence numeric not null check(confidence>=0 and confidence<=1),
  source_clean_body_sha256 text not null,
  source_region_sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(analysis_run_id,candidate_id,article_id),
  check(length(btrim(rationale))>=6),
  check(
    (relation='none' and coalesce(btrim(clean_body_anchor),'')='' and coalesce(btrim(source_region_anchor),'')='' and subject is null and measurement is null)
    or
    (relation<>'none' and length(btrim(coalesce(clean_body_anchor,'')))>=6 and length(btrim(coalesce(source_region_anchor,'')))>=6 and subject is not null and measurement is not null)
  )
);

create index if not exists source_region_jobs_status_idx on public.article_source_region_jobs_v1(status,next_retry_at);
create index if not exists embedding_jobs_status_idx on public.article_embedding_jobs_v2(status,next_retry_at);
create index if not exists article_reviews_v4_run_batch_idx on public.full_corpus_article_reviews_v4(run_id,batch_index);
create index if not exists article_review_anchors_v4_review_idx on public.full_corpus_article_review_anchors_v4(review_id);
create index if not exists theme_seeds_v4_run_article_idx on public.full_corpus_theme_seeds_v4(run_id,article_id);
create index if not exists theme_seed_mappings_v4_run_candidate_idx on public.theme_seed_mappings_v4(analysis_run_id,candidate_id);
create index if not exists theme_census_batches_v4_status_idx on public.theme_census_batches_v4(analysis_run_id,status,next_retry_at);
create index if not exists theme_census_relations_v4_run_candidate_idx on public.theme_census_relations_v4(analysis_run_id,candidate_id,relation);
create index if not exists theme_census_relations_v4_article_idx on public.theme_census_relations_v4(analysis_run_id,article_id);

alter table public.article_source_region_jobs_v1 enable row level security;
alter table public.article_embedding_jobs_v2 enable row level security;
alter table public.full_corpus_article_reviews_v4 enable row level security;
alter table public.full_corpus_article_review_anchors_v4 enable row level security;
alter table public.full_corpus_theme_seeds_v4 enable row level security;
alter table public.theme_analysis_runs_v4 enable row level security;
alter table public.theme_candidates_v4 enable row level security;
alter table public.theme_seed_mappings_v4 enable row level security;
alter table public.theme_census_batches_v4 enable row level security;
alter table public.theme_census_relations_v4 enable row level security;

revoke all on public.article_source_region_jobs_v1,public.article_embedding_jobs_v2,public.full_corpus_article_reviews_v4,public.full_corpus_article_review_anchors_v4,public.full_corpus_theme_seeds_v4,public.theme_analysis_runs_v4,public.theme_candidates_v4,public.theme_seed_mappings_v4,public.theme_census_batches_v4,public.theme_census_relations_v4 from public,anon,authenticated;
grant select,insert,update,delete on public.article_source_region_jobs_v1,public.article_embedding_jobs_v2,public.full_corpus_article_reviews_v4,public.full_corpus_article_review_anchors_v4,public.full_corpus_theme_seeds_v4,public.theme_analysis_runs_v4,public.theme_candidates_v4,public.theme_seed_mappings_v4,public.theme_census_batches_v4,public.theme_census_relations_v4 to service_role;
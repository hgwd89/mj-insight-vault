-- MJ Insight Vault schema
-- Run this in Supabase SQL Editor.

create extension if not exists vector;

create table if not exists upload_batches (
  id uuid primary key default gen_random_uuid(),
  memo text,
  image_count integer not null default 0,
  status text not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists source_images (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references upload_batches(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  mime_type text,
  width integer,
  height integer,
  ocr_status text not null default 'pending',
  ocr_text_raw text,
  ocr_json jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references upload_batches(id) on delete cascade,
  source_image_id uuid references source_images(id) on delete cascade,
  headline text,
  article_date text,
  article_index integer not null default 0,
  ocr_text text,
  article_type text not null default 'article',
  has_table boolean not null default false,
  has_chart boolean not null default false,
  has_image boolean not null default false,
  status text not null default 'ocr_done',
  manual_analysis jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tag_master (
  id uuid primary key default gen_random_uuid(),
  tag_type text not null,
  tag_name text not null,
  description text,
  created_at timestamptz not null default now(),
  unique(tag_type, tag_name)
);

create table if not exists article_tags (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references articles(id) on delete cascade,
  tag_type text not null,
  tag_name text not null,
  is_ai_generated boolean not null default false,
  created_at timestamptz not null default now(),
  unique(article_id, tag_type, tag_name)
);

create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references articles(id) on delete cascade,
  analysis_type text not null,
  analysis_json jsonb,
  analysis_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chat_reports (
  id uuid primary key default gen_random_uuid(),
  user_query text not null,
  answer_text text,
  answer_json jsonb,
  related_article_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists article_embeddings (
  id uuid primary key default gen_random_uuid(),
  article_id uuid references articles(id) on delete cascade unique,
  embedding_text text not null,
  embedding_vector vector(1536),
  created_at timestamptz not null default now()
);

create index if not exists idx_source_images_batch on source_images(batch_id);
create index if not exists idx_articles_batch on articles(batch_id);
create index if not exists idx_articles_source_image on articles(source_image_id);
create index if not exists idx_article_tags_name on article_tags(tag_type, tag_name);
create index if not exists idx_articles_ocr_fts on articles using gin (to_tsvector('simple', coalesce(headline,'') || ' ' || coalesce(ocr_text,'')));
create index if not exists idx_article_embeddings_vector on article_embeddings using ivfflat (embedding_vector vector_cosine_ops) with (lists = 100);

create or replace function match_articles(query_embedding vector(1536), match_count int default 12)
returns table (
  article_id uuid,
  headline text,
  ocr_text text,
  similarity float
)
language sql stable
as $$
  select
    a.id as article_id,
    a.headline,
    a.ocr_text,
    1 - (ae.embedding_vector <=> query_embedding) as similarity
  from article_embeddings ae
  join articles a on a.id = ae.article_id
  where ae.embedding_vector is not null
  order by ae.embedding_vector <=> query_embedding
  limit match_count;
$$;

insert into tag_master(tag_type, tag_name, description) values
('industry','化粧品','重視業界'),
('industry','食品','重視業界'),
('industry','AI・生成AI','重視業界'),
('industry','飲料',null),('industry','外食',null),('industry','小売',null),('industry','EC',null),('industry','日用品',null),('industry','美容',null),('industry','ヘルスケア',null),('industry','家電',null),('industry','住居',null),('industry','金融',null),('industry','保険',null),('industry','旅行',null),('industry','交通',null),('industry','エンタメ',null),('industry','教育',null),('industry','子育て',null),('industry','シニア',null),('industry','若者',null),('industry','ペット',null),('industry','地域',null),('industry','その他',null),
('consumer_pressure','物価高',null),('consumer_pressure','時間不足',null),('consumer_pressure','健康不安',null),('consumer_pressure','将来不安',null),('consumer_pressure','孤独',null),('consumer_pressure','情報過多',null),('consumer_pressure','選択疲れ',null),('consumer_pressure','家事負担',null),('consumer_pressure','見た目不安',null),('consumer_pressure','失敗回避',null),('consumer_pressure','損失回避',null),('consumer_pressure','環境意識',null),('consumer_pressure','デジタル疲れ',null),('consumer_pressure','人間関係疲れ',null),('consumer_pressure','老い不安',null),
('behavior_change','節約',null),('behavior_change','代替',null),('behavior_change','削減',null),('behavior_change','先送り',null),('behavior_change','少量化',null),('behavior_change','高付加価値化',null),('behavior_change','使い分け',null),('behavior_change','共有',null),('behavior_change','サブスク化',null),('behavior_change','解約',null),('behavior_change','再評価',null),('behavior_change','習慣化',null),('behavior_change','儀式化',null),('behavior_change','セルフ化',null),('behavior_change','外注化',null),('behavior_change','回避',null),('behavior_change','まとめ買い',null),('behavior_change','近場化',null),('behavior_change','ソロ化',null),('behavior_change','コミュニティ化',null),
('method_fit','N1探索',null),('method_fit','ビジュアル投影',null),('method_fit','BOT調査',null),('method_fit','リフレクション',null),('method_fit','定量調査',null)
on conflict(tag_type, tag_name) do nothing;

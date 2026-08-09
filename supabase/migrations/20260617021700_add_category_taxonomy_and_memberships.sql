create table if not exists public.analysis_categories (
  id text primary key,
  name_ja text not null,
  parent_id text references public.analysis_categories(id),
  description text,
  keywords text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.article_category_memberships (
  article_id uuid not null references public.articles(id) on delete cascade,
  category_id text not null references public.analysis_categories(id) on delete cascade,
  score numeric not null default 0,
  confidence numeric not null default 0,
  source text not null default 'rule_based_v1',
  match_terms text[] not null default '{}',
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (article_id, category_id)
);

create index if not exists idx_article_category_memberships_category on public.article_category_memberships(category_id, score desc);
create index if not exists idx_article_category_memberships_article on public.article_category_memberships(article_id);
create index if not exists idx_article_category_memberships_terms on public.article_category_memberships using gin(match_terms);

insert into public.analysis_categories (id, name_ja, parent_id, description, keywords)
values
  ('beauty_cosmetics','化粧品・美容',null,'化粧品、スキンケア、メイク、香り、ヘアケア、美容接点',array['化粧品','美容','スキンケア','メイク','コスメ','肌','UV','日焼け止め','香り','ヘアケア','美容液','ファンデーション','リップ','資生堂','コーセー','花王']),
  ('food_beverage','食品・飲料',null,'食品、飲料、外食、惣菜、菓子、健康食品',array['食品','飲料','外食','冷凍','菓子','コーヒー','惣菜','スーパー','健康食品','ビール','酒']),
  ('retail_channel','小売・流通・店頭',null,'小売、百貨店、ドラッグストア、コンビニ、EC、売場接点',array['小売','百貨店','ドラッグストア','コンビニ','EC','通販','店舗','売り場','来店','店頭','売場']),
  ('health_wellness','健康・ウェルネス',null,'健康、睡眠、疲労、医療、介護、ウェルネス',array['健康','医療','睡眠','疲労','介護','ウェルネス','予防','セルフケア']),
  ('digital_ai','デジタル・AI・アプリ',null,'AI、アプリ、SNS、デジタル接点、オンライン行動',array['AI','アプリ','SNS','デジタル','スマホ','オンライン','データ','生成AI']),
  ('fashion_apparel','ファッション・アパレル',null,'衣料、ファッション、装い、靴、バッグ、アクセサリー',array['ファッション','アパレル','衣料','服','装い','靴','バッグ','アクセサリー']),
  ('household_daily','日用品・家庭生活',null,'日用品、家庭用品、掃除、洗濯、家事、住生活',array['日用品','家庭','家事','掃除','洗濯','住まい','住宅','収納','キッチン']),
  ('mobility_travel','移動・旅行・レジャー',null,'旅行、観光、移動、レジャー、交通、外出行動',array['旅行','観光','移動','交通','レジャー','ホテル','外出','インバウンド']),
  ('finance_value','価格・節約・金融',null,'価格、節約、物価、金融、ポイント、家計',array['値上げ','物価','節約','価格','家計','金融','ポイント','割安','高付加価値']),
  ('sustainability','環境・サステナビリティ',null,'環境配慮、サステナビリティ、リサイクル、エシカル',array['環境','サステナ','リサイクル','エシカル','脱炭素','再利用']),
  ('youth_sns','若者・Z世代・SNS文化',null,'若者、Z世代、SNS、推し活、発信文化',array['若者','Z世代','SNS','推し','推し活','TikTok','インスタ','発信']),
  ('senior_family','シニア・家族・ライフステージ',null,'シニア、子育て、家族、介護、世代変化',array['シニア','高齢','子育て','家族','介護','親子','世代']),
  ('experience_personalization','体験・診断・パーソナライズ',null,'診断、体験、個別化、接客、サービス体験',array['体験','診断','パーソナル','個別','接客','カウンセリング','レコメンド'])
on conflict (id) do update set
  name_ja = excluded.name_ja,
  parent_id = excluded.parent_id,
  description = excluded.description,
  keywords = excluded.keywords,
  is_active = true,
  updated_at = now();
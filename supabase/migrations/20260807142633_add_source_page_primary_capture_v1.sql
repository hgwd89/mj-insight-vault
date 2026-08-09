create table public.source_page_primary_capture_v1 (
  page_identity_source_image_id uuid primary key references public.source_images(id),
  evidence_source_image_id uuid not null references public.source_images(id),
  freeze_receipt_id uuid not null references public.formal_corpus_freeze_receipts_v1(id),
  selection_version text not null default 'primary_capture_v1',
  article_count integer not null,
  headline_ge020_count integer not null,
  headline_ge015_count integer not null,
  headline_ge012_count integer not null,
  min_headline_seed numeric,
  avg_headline_seed numeric,
  avg_ocr_confidence numeric,
  selection_status text not null check(selection_status in ('selected','needs_secondary_grounding')),
  selected_at timestamptz not null default now()
);
create index source_page_primary_capture_v1_evidence_idx on public.source_page_primary_capture_v1(evidence_source_image_id);

create table public.article_source_grounding_reviews_v3 (
  article_id uuid not null references public.articles(id) on delete cascade,
  evidence_source_image_id uuid not null references public.source_images(id),
  review_version text not null default 'source_grounding_v3',
  headline_similarity numeric not null,
  shared_terms text[] not null default '{}'::text[],
  mapper_model text,
  critic_model text,
  mapper_decision text not null check(mapper_decision in ('passed','failed')),
  critic_decision text not null check(critic_decision in ('passed','failed')),
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(article_id,evidence_source_image_id,review_version)
);

create function public.validate_article_source_grounding_review_v3()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare
  v_article_source uuid;
  v_article_page uuid;
  v_evidence_page uuid;
  v_article_text text;
  v_source_text text;
  v_term text;
  v_valid_terms integer:=0;
  v_total_chars integer:=0;
begin
  select f.source_image_id, coalesce(f.headline,'')||' '||coalesce(a.analysis_body_clean,'')
    into v_article_source,v_article_text
  from public.formal_corpus_articles_v1 f join public.articles a on a.id=f.id
  where f.id=new.article_id;
  if v_article_source is null then raise exception 'grounding_review_article_not_current_formal'; end if;

  select page_identity_source_image_id into v_article_page from public.source_page_capture_map_v1 where source_image_id=v_article_source;
  select page_identity_source_image_id into v_evidence_page from public.source_page_capture_map_v1 where source_image_id=new.evidence_source_image_id;
  if v_article_page is null or v_evidence_page is null or v_article_page<>v_evidence_page then raise exception 'grounding_review_capture_not_same_page_identity'; end if;

  select coalesce(ocr_text_raw,'') into v_source_text from public.source_images where id=new.evidence_source_image_id;
  if v_source_text='' then raise exception 'grounding_review_source_ocr_missing'; end if;

  if coalesce(array_length(new.shared_terms,1),0)<3 then raise exception 'grounding_review_requires_three_shared_terms'; end if;
  foreach v_term in array new.shared_terms loop
    v_term:=btrim(v_term);
    if char_length(v_term)>=3 and position(v_term in v_article_text)>0 and position(v_term in v_source_text)>0 then
      v_valid_terms:=v_valid_terms+1;
      v_total_chars:=v_total_chars+char_length(v_term);
    end if;
  end loop;
  if v_valid_terms<3 or v_total_chars<12 then raise exception 'grounding_review_shared_terms_not_sufficient'; end if;
  if new.mapper_decision<>'passed' or new.critic_decision<>'passed' then
    return new;
  end if;
  return new;
end $$;
create trigger article_source_grounding_reviews_v3_validate
before insert or update on public.article_source_grounding_reviews_v3
for each row execute function public.validate_article_source_grounding_review_v3();
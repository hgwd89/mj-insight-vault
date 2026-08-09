create table public.source_page_capture_map_v1 (
  source_image_id uuid primary key references public.source_images(id) on delete cascade,
  page_identity_source_image_id uuid not null references public.source_images(id),
  identity_version text not null default 'page_identity_v1',
  identity_method text not null,
  identity_confidence numeric not null default 1.0 check (identity_confidence >= 0 and identity_confidence <= 1),
  evidence_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index source_page_capture_map_v1_identity_idx on public.source_page_capture_map_v1(page_identity_source_image_id);

create function public.ensure_source_page_capture_map_v1()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.source_page_capture_map_v1(source_image_id,page_identity_source_image_id,identity_method,identity_confidence,evidence_json)
  values(new.id,new.id,'self_capture_default',1.0,jsonb_build_object('source_image_id',new.id))
  on conflict(source_image_id) do nothing;
  return new;
end $$;

create trigger source_images_page_identity_default_v1
after insert on public.source_images
for each row execute function public.ensure_source_page_capture_map_v1();

create view public.formal_corpus_page_identity_v1 as
select f.id as article_id,
       f.source_image_id as capture_source_image_id,
       m.page_identity_source_image_id,
       m.identity_method,
       m.identity_confidence
from public.formal_corpus_articles_v1 f
left join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id;

create view public.formal_source_page_identity_gate_v1 as
with f as (
  select f.id article_id,f.source_image_id,m.page_identity_source_image_id,s.publication_date capture_date,r.publication_date identity_date,m.identity_confidence
  from public.formal_corpus_articles_v1 f
  left join public.source_page_capture_map_v1 m on m.source_image_id=f.source_image_id
  left join public.source_images s on s.id=f.source_image_id
  left join public.source_images r on r.id=m.page_identity_source_image_id
)
select count(*)::int formal_article_count,
       count(distinct source_image_id)::int capture_count,
       count(distinct page_identity_source_image_id)::int page_identity_count,
       count(*) filter(where page_identity_source_image_id is null)::int unmapped_article_count,
       count(*) filter(where page_identity_source_image_id is not null and capture_date is distinct from identity_date)::int identity_date_mismatch_count,
       count(*) filter(where coalesce(identity_confidence,0) < 1.0)::int nonfinal_identity_count,
       case when count(*)>0 and count(*) filter(where page_identity_source_image_id is null)=0 and count(*) filter(where page_identity_source_image_id is not null and capture_date is distinct from identity_date)=0 and count(*) filter(where coalesce(identity_confidence,0) < 1.0)=0 then 'passed' else 'failed' end as page_identity_gate
from f;
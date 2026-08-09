create table if not exists public.source_ocr_blocks_v1 (
  source_image_id uuid not null references public.source_images(id) on delete cascade,
  page_index integer not null,
  block_index integer not null,
  block_text text not null,
  x_min integer,
  y_min integer,
  x_max integer,
  y_max integer,
  ocr_confidence numeric,
  source_ocr_json_sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(source_image_id,page_index,block_index)
);

create index if not exists source_ocr_blocks_v1_source_xy_idx
  on public.source_ocr_blocks_v1(source_image_id,page_index,x_min,y_min);
create index if not exists source_ocr_blocks_v1_text_trgm_idx
  on public.source_ocr_blocks_v1 using gin(block_text gin_trgm_ops);

create or replace function public.refresh_source_ocr_blocks_v1(p_source_image_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $$
declare
  v_json jsonb;
  v_hash text;
  v_count integer;
begin
  select ocr_json,
         encode(extensions.digest(convert_to(coalesce(ocr_json,'{}'::jsonb)::text,'UTF8'),'sha256'::text),'hex')
    into v_json,v_hash
  from public.source_images where id=p_source_image_id;
  if not found then return 0; end if;

  delete from public.source_ocr_blocks_v1 where source_image_id=p_source_image_id;
  if v_json is null or not (v_json ? 'fullTextAnnotation') then return 0; end if;

  insert into public.source_ocr_blocks_v1(
    source_image_id,page_index,block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256,updated_at
  )
  select p_source_image_id,
         (p.ord-1)::integer,
         (b.ord-1)::integer,
         public.vision_ocr_block_text_v1(b.block),
         (select min(coalesce((v.value->>'x')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)),
         (select min(coalesce((v.value->>'y')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)),
         (select max(coalesce((v.value->>'x')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)),
         (select max(coalesce((v.value->>'y')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)),
         coalesce((b.block->>'confidence')::numeric,0),
         v_hash,
         now()
  from jsonb_array_elements(coalesce(v_json->'fullTextAnnotation'->'pages','[]'::jsonb)) with ordinality p(page,ord)
  cross join lateral jsonb_array_elements(coalesce(p.page->'blocks','[]'::jsonb)) with ordinality b(block,ord)
  where coalesce(public.vision_ocr_block_text_v1(b.block),'')<>'';

  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

create or replace function public.trg_refresh_source_ocr_blocks_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
begin
  perform public.refresh_source_ocr_blocks_v1(new.id);
  return new;
end;
$$;

drop trigger if exists trg_refresh_source_ocr_blocks_v1 on public.source_images;
create trigger trg_refresh_source_ocr_blocks_v1
after insert or update of ocr_json on public.source_images
for each row execute function public.trg_refresh_source_ocr_blocks_v1();

select public.refresh_source_ocr_blocks_v1(id)
from public.source_images
where ocr_json is not null and ocr_json ? 'fullTextAnnotation';

create or replace view public.formal_source_ocr_blocks_v1 as
select
  f.id as article_id,
  f.source_image_id,
  b.page_index,
  b.block_index,
  b.block_text,
  b.x_min,
  b.x_max,
  b.y_min,
  b.y_max,
  b.ocr_confidence
from public.formal_corpus_articles_v1 f
join public.source_ocr_blocks_v1 b on b.source_image_id=f.source_image_id;
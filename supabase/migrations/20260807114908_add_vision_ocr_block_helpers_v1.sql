create or replace function public.vision_ocr_block_text_v1(p_block jsonb)
returns text
language sql
immutable
set search_path to 'pg_catalog','public'
as $$
  select coalesce(string_agg(sym.value->>'text','' order by p.ord,w.ord,sym.ord),'')
  from jsonb_array_elements(coalesce(p_block->'paragraphs','[]'::jsonb)) with ordinality p(value,ord)
  cross join lateral jsonb_array_elements(coalesce(p.value->'words','[]'::jsonb)) with ordinality w(value,ord)
  cross join lateral jsonb_array_elements(coalesce(w.value->'symbols','[]'::jsonb)) with ordinality sym(value,ord)
$$;

create or replace view public.formal_source_ocr_blocks_v1 as
select
  f.id as article_id,
  f.source_image_id,
  0::integer as page_index,
  (b.ord-1)::integer as block_index,
  public.vision_ocr_block_text_v1(b.block) as block_text,
  (select min(coalesce((v.value->>'x')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)) as x_min,
  (select max(coalesce((v.value->>'x')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)) as x_max,
  (select min(coalesce((v.value->>'y')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)) as y_min,
  (select max(coalesce((v.value->>'y')::integer,0)) from jsonb_array_elements(coalesce(b.block->'boundingBox'->'vertices','[]'::jsonb)) v(value)) as y_max,
  coalesce((b.block->>'confidence')::numeric,0) as ocr_confidence
from public.formal_corpus_articles_v1 f
join public.source_images s on s.id=f.source_image_id
cross join lateral jsonb_array_elements(coalesce(s.ocr_json->'fullTextAnnotation'->'pages'->0->'blocks','[]'::jsonb)) with ordinality b(block,ord)
where coalesce(public.vision_ocr_block_text_v1(b.block),'')<>'';
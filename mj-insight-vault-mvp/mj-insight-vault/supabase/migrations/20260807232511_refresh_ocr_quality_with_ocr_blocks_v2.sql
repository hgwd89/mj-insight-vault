create or replace function public.refresh_source_ocr_block_quality_v2(p_source_image_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_count integer:=0;
begin
  delete from public.source_ocr_block_quality_v2 where source_image_id=p_source_image_id;

  insert into public.source_ocr_block_quality_v2(
    source_image_id,page_index,block_index,source_ocr_json_sha256,
    symbol_count,avg_symbol_confidence,p10_symbol_confidence,symbols_lt_080,symbols_lt_060,
    digit_symbol_count,avg_digit_confidence,digits_lt_080,digits_lt_060,quality_status,computed_at
  )
  with symbols as (
    select
      si.id as source_image_id,
      (pg.ord-1)::integer as page_index,
      (bl.ord-1)::integer as block_index,
      case when sym.value ? 'confidence' then (sym.value->>'confidence')::numeric else null end as conf,
      coalesce(sym.value->>'text','') as txt
    from public.source_images si
    cross join lateral jsonb_array_elements(coalesce(si.ocr_json->'fullTextAnnotation'->'pages','[]'::jsonb)) with ordinality pg(value,ord)
    cross join lateral jsonb_array_elements(coalesce(pg.value->'blocks','[]'::jsonb)) with ordinality bl(value,ord)
    cross join lateral jsonb_array_elements(coalesce(bl.value->'paragraphs','[]'::jsonb)) para(value)
    cross join lateral jsonb_array_elements(coalesce(para.value->'words','[]'::jsonb)) w(value)
    cross join lateral jsonb_array_elements(coalesce(w.value->'symbols','[]'::jsonb)) sym(value)
    where si.id=p_source_image_id
  ), agg as (
    select
      source_image_id,page_index,block_index,
      count(conf)::integer as symbol_count,
      avg(conf) as avg_conf,
      (percentile_cont(0.1) within group(order by conf))::numeric as p10_conf,
      count(*) filter(where conf<0.80)::integer as low80,
      count(*) filter(where conf<0.60)::integer as low60,
      count(*) filter(where txt ~ '^[0-9０-９]$' and conf is not null)::integer as digit_count,
      avg(conf) filter(where txt ~ '^[0-9０-９]$') as digit_avg,
      count(*) filter(where txt ~ '^[0-9０-９]$' and conf<0.80)::integer as digit_low80,
      count(*) filter(where txt ~ '^[0-9０-９]$' and conf<0.60)::integer as digit_low60
    from symbols
    group by source_image_id,page_index,block_index
  )
  select
    b.source_image_id,b.page_index,b.block_index,b.source_ocr_json_sha256,
    coalesce(a.symbol_count,0),a.avg_conf,a.p10_conf,coalesce(a.low80,0),coalesce(a.low60,0),
    coalesce(a.digit_count,0),a.digit_avg,coalesce(a.digit_low80,0),coalesce(a.digit_low60,0),
    public.classify_source_ocr_block_quality_v2(
      coalesce(a.symbol_count,0),a.avg_conf,a.p10_conf,coalesce(a.low80,0),
      coalesce(a.digit_count,0),a.digit_avg,coalesce(a.digit_low80,0)
    ),now()
  from public.source_ocr_blocks_v1 b
  left join agg a on a.source_image_id=b.source_image_id and a.page_index=b.page_index and a.block_index=b.block_index
  where b.source_image_id=p_source_image_id;

  get diagnostics v_count=row_count;
  return v_count;
end
$$;

revoke all on function public.refresh_source_ocr_block_quality_v2(uuid) from public,anon,authenticated;
grant execute on function public.refresh_source_ocr_block_quality_v2(uuid) to service_role;

create or replace function public.trg_refresh_source_ocr_blocks_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  perform public.refresh_source_ocr_blocks_v1(new.id);
  perform public.refresh_source_ocr_block_quality_v2(new.id);
  return new;
end
$$;
revoke all on function public.trg_refresh_source_ocr_blocks_v1() from public,anon,authenticated;

grant execute on function public.trg_refresh_source_ocr_blocks_v1() to service_role;
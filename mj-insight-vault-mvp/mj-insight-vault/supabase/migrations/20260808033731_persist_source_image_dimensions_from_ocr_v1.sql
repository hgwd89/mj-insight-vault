begin;

create or replace function public.set_source_image_dimensions_from_ocr_v1()
returns trigger
language plpgsql
set search_path=pg_catalog,public
as $function$
declare v_w text;v_h text;
begin
  v_w:=new.ocr_json->'fullTextAnnotation'->'pages'->0->>'width';
  v_h:=new.ocr_json->'fullTextAnnotation'->'pages'->0->>'height';
  if coalesce(v_w,'')~'^\d+$' and v_w::integer>0 then new.width:=v_w::integer; end if;
  if coalesce(v_h,'')~'^\d+$' and v_h::integer>0 then new.height:=v_h::integer; end if;
  return new;
end
$function$;
revoke all on function public.set_source_image_dimensions_from_ocr_v1() from public,anon,authenticated;

drop trigger if exists trg_00_set_source_image_dimensions_from_ocr_v1 on public.source_images;
create trigger trg_00_set_source_image_dimensions_from_ocr_v1
before insert or update of ocr_json on public.source_images
for each row execute function public.set_source_image_dimensions_from_ocr_v1();

update public.source_images
set width=(ocr_json->'fullTextAnnotation'->'pages'->0->>'width')::integer,
    height=(ocr_json->'fullTextAnnotation'->'pages'->0->>'height')::integer
where ocr_json is not null
  and coalesce(ocr_json->'fullTextAnnotation'->'pages'->0->>'width','')~'^\d+$'
  and coalesce(ocr_json->'fullTextAnnotation'->'pages'->0->>'height','')~'^\d+$'
  and ((width is null or width<=0) or (height is null or height<=0));

commit;
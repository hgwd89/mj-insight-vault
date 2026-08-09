create or replace function public.maintain_source_image_ocr_identity_v2()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  v_raw text := coalesce(new.ocr_text_raw,'');
  v_raw_hash text;
  v_norm_hash text;
  v_canonical uuid;
begin
  if btrim(v_raw)='' then
    new.raw_ocr_sha256:=null;
    new.normalized_ocr_sha256:=null;
    new.duplicate_of_source_image_id:=null;
    new.duplicate_reason:=null;
    return new;
  end if;

  v_raw_hash:=encode(extensions.digest(convert_to(v_raw,'UTF8'),'sha256'),'hex');
  v_norm_hash:=encode(extensions.digest(convert_to(lower(regexp_replace(v_raw,'[[:space:]]+','','g')),'UTF8'),'sha256'),'hex');
  new.raw_ocr_sha256:=v_raw_hash;
  new.normalized_ocr_sha256:=v_norm_hash;

  select s.id into v_canonical
  from public.source_images s
  where s.id<>new.id
    and s.normalized_ocr_sha256=v_norm_hash
    and s.duplicate_of_source_image_id is null
  order by s.created_at,s.id
  limit 1;

  if v_canonical is not null then
    new.duplicate_of_source_image_id:=v_canonical;
    new.duplicate_reason:='normalized_raw_ocr_sha256_exact_v2';
  elsif new.duplicate_reason like 'normalized_raw_ocr_sha256_exact%' then
    new.duplicate_of_source_image_id:=null;
    new.duplicate_reason:=null;
  end if;
  return new;
end;
$function$;

revoke all on function public.maintain_source_image_ocr_identity_v2() from public,anon,authenticated;
grant execute on function public.maintain_source_image_ocr_identity_v2() to postgres,service_role;

drop trigger if exists trg_00_maintain_source_image_ocr_identity_v2 on public.source_images;
create trigger trg_00_maintain_source_image_ocr_identity_v2
before insert or update of ocr_text_raw on public.source_images
for each row execute function public.maintain_source_image_ocr_identity_v2();
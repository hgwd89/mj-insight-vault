begin;

alter table public.ocr_verification_crop_ocr_v4
  alter column crop_version set default 'article_block_mask_composite_v2';

create or replace function public.replace_ocr_crop_results_v4(p_job_id uuid, p_lease_token uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','extensions'
as $function$
declare
  j public.ocr_verification_page_jobs_v2%rowtype;
  r jsonb;
  v_input integer;
  v_total integer;
begin
  select * into j from public.ocr_verification_page_jobs_v2 where id=p_job_id for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then
    raise exception 'ocr_crop_v4_lease_invalid';
  end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)<1 then
    raise exception 'ocr_crop_v4_rows_required';
  end if;
  v_input:=jsonb_array_length(p_rows);
  for r in select value from jsonb_array_elements(p_rows) loop
    if not exists(select 1 from public.formal_source_grounded_articles_v6 g where g.partition_job_id=j.partition_job_id and g.article_id=(r->>'article_id')::uuid) then
      raise exception 'ocr_crop_v4_unknown_article';
    end if;
    if coalesce(btrim(r->>'crop_ocr_text'),'')='' then raise exception 'ocr_crop_v4_empty_text'; end if;
    if coalesce(r->>'crop_spec_sha256','')!~'^[0-9a-f]{64}$' or coalesce(r->>'crop_image_sha256','')!~'^[0-9a-f]{64}$' or coalesce(r->>'google_response_sha256','')!~'^[0-9a-f]{64}$' then
      raise exception 'ocr_crop_v4_receipt_invalid';
    end if;
    insert into public.ocr_verification_crop_ocr_v4(
      job_id,article_id,crop_version,crop_spec_sha256,crop_image_sha256,google_response_sha256,crop_ocr_text,crop_ocr_text_sha256
    ) values(
      j.id,(r->>'article_id')::uuid,'article_block_mask_composite_v2',r->>'crop_spec_sha256',r->>'crop_image_sha256',r->>'google_response_sha256',r->>'crop_ocr_text',
      encode(extensions.digest(convert_to(r->>'crop_ocr_text','UTF8'),'sha256'),'hex')
    )
    on conflict(job_id,article_id) do update set
      crop_version='article_block_mask_composite_v2',
      crop_spec_sha256=excluded.crop_spec_sha256,
      crop_image_sha256=excluded.crop_image_sha256,
      google_response_sha256=excluded.google_response_sha256,
      crop_ocr_text=excluded.crop_ocr_text,
      crop_ocr_text_sha256=excluded.crop_ocr_text_sha256,
      created_at=now();
  end loop;
  select count(*)::integer into v_total from public.ocr_verification_crop_ocr_v4 where job_id=j.id;
  if v_total>j.article_count then raise exception 'ocr_crop_v4_article_count_overflow'; end if;
  return jsonb_build_object('status','stored','chunk_rows',v_input,'total_rows',v_total,'expected_rows',j.article_count,'complete',v_total=j.article_count,'crop_version','article_block_mask_composite_v2');
end
$function$;

commit;
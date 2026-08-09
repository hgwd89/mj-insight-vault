create or replace function public.clean_article_analysis_body_v1(p_text text)
returns text
language plpgsql
immutable
set search_path to 'pg_catalog','public'
as $function$
declare
  v text := coalesce(p_text,'');
  marker text;
  p integer;
begin
  p := position('【OCR照合メモ】' in v);
  if p>0 then v:=left(v,p-1); end if;

  p := position('【本文再構成】' in v);
  if p>0 then v:=substr(v,p+length('【本文再構成】')); end if;

  foreach marker in array array[
    '【主要事実】','【固有名詞】','【数字・根拠】','【発言・記事内主張】','【図表】','【全体信頼度】'
  ] loop
    p:=position(marker in v);
    if p>0 then v:=left(v,p-1); end if;
  end loop;

  v:=regexp_replace(v,'^\s*【GPT記事構造化】\s*','','g');
  v:=regexp_replace(v,'[\r\n]{3,}',E'\n\n','g');
  return btrim(v);
end;
$function$;

revoke all on function public.clean_article_analysis_body_v1(text) from public,anon,authenticated;
grant execute on function public.clean_article_analysis_body_v1(text) to postgres,service_role;

create or replace view public.formal_article_analysis_text_v2
with (security_invoker=true)
as
select a.id article_id,a.headline,a.article_date,a.article_type,a.source_image_id,
       public.clean_article_analysis_body_v1(a.ocr_text) analysis_body,
       encode(extensions.digest(convert_to(public.clean_article_analysis_body_v1(a.ocr_text),'UTF8'),'sha256'),'hex') analysis_body_sha256,
       length(public.clean_article_analysis_body_v1(a.ocr_text)) analysis_body_chars,
       s.ocr_text_raw source_ocr_text,
       s.raw_ocr_sha256 source_raw_ocr_sha256,
       s.normalized_ocr_sha256 source_normalized_ocr_sha256,
       a.analysis_text_sha256 legacy_analysis_text_sha256,
       a.reconstruction_confidence,a.provenance_status
from public.formal_corpus_articles_v1 a
join public.source_images s on s.id=a.source_image_id
where coalesce(public.clean_article_analysis_body_v1(a.ocr_text),'')<>''
  and coalesce(s.ocr_text_raw,'')<>'';

revoke all on public.formal_article_analysis_text_v2 from public,anon,authenticated;
grant select on public.formal_article_analysis_text_v2 to postgres,service_role;
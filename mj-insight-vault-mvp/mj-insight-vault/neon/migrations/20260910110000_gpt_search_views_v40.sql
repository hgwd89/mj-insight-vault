-- GPT-first retrieval views.
-- Google Drive originals remain the source of truth; these views are read-only search indexes.
-- Article segmentation is optional enrichment. gpt_source_search covers OCR-complete sources even when no article rows exist.

create or replace view public.gpt_source_search as
select
  s.id as source_file_id,
  s.file_name,
  s.mime_type,
  s.article_date,
  s.ocr_status,
  s.source_status,
  s.drive_file_id,
  case
    when coalesce(s.drive_file_id, '') <> ''
      then 'https://drive.google.com/file/d/' || s.drive_file_id || '/view'
    else null
  end as original_drive_url,
  coalesce(a.ocr_text_verified, a.ocr_text_raw, '') as ocr_text,
  length(coalesce(a.ocr_text_verified, a.ocr_text_raw, '')) as text_chars,
  md5(lower(regexp_replace(coalesce(a.ocr_text_verified, a.ocr_text_raw, ''), '\s+', '', 'g'))) as normalized_md5,
  s.updated_at as source_updated_at
from public.vault_source_files s
left join public.vault_articles a
  on a.source_file_id = s.id
 and a.article_sequence = 0
where s.source_status is distinct from 'e2e_test'
  and s.ocr_status = 'done';

create or replace view public.gpt_article_search as
select
  a.id as article_id,
  a.source_file_id,
  a.article_sequence,
  s.article_date,
  a.title,
  coalesce(a.ocr_text_verified, a.ocr_text_raw, '') as article_text,
  length(coalesce(a.ocr_text_verified, a.ocr_text_raw, '')) as text_chars,
  md5(lower(regexp_replace(coalesce(a.ocr_text_verified, a.ocr_text_raw, ''), '\s+', '', 'g'))) as normalized_md5,
  s.file_name as original_file_name,
  s.drive_file_id,
  case
    when coalesce(s.drive_file_id, '') <> ''
      then 'https://drive.google.com/file/d/' || s.drive_file_id || '/view'
    else null
  end as original_drive_url,
  a.verification_status,
  a.verification_version,
  a.updated_at
from public.vault_articles a
join public.vault_source_files s on s.id = a.source_file_id
where a.article_sequence > 0
  and a.verification_status = 'article_organized'
  and s.source_status is distinct from 'e2e_test';

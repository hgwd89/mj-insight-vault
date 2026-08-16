update public.chat_jobs j
set result_json = jsonb_build_object(
  'answer', jsonb_build_object(
    'report_title', coalesce(nullif(r.answer_json->>'report_title',''), 'レポート'),
    'answer_text', left(coalesce(r.answer_text,''), 180)
  ),
  'report', jsonb_build_object('id', r.id)
),
updated_at = now()
from public.chat_reports r
where j.status='completed'
  and j.report_id=r.id
  and j.result_json is not null
  and pg_column_size(j.result_json) > 16384;

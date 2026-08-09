create or replace function public.put_substantive_report_body_first(value text)
returns text
language plpgsql
immutable
as $$
declare
  src text;
  idx integer;
  body text;
  prefix text;
begin
  src := coalesce(value, '');
  src := replace(src, '直接該当記事数:', 'LLM個別本文投入記事数:');
  src := replace(src, '直接該当:', 'LLM個別本文投入記事数:');
  src := replace(src, '根拠確認用記事数:', '根拠記事リスト:');

  idx := position('## 1. 結論' in src);
  if idx = 0 then
    idx := position('## 1 結論' in src);
  end if;
  if idx = 0 then
    idx := position('## 結論' in src);
  end if;
  if idx = 0 then
    return src;
  end if;

  body := btrim(substring(src from idx));
  prefix := btrim(substring(src from 1 for idx - 1));

  if prefix = '' then
    return body;
  end if;

  if position('## 99. カバレッジ・システム情報' in body) > 0 then
    return body;
  end if;

  return body || E'\n\n## 99. カバレッジ・システム情報\n' || prefix;
end;
$$;

create or replace function public.reorder_chat_report_answer_text()
returns trigger
language plpgsql
as $$
begin
  new.answer_text := public.put_substantive_report_body_first(new.answer_text);
  new.answer_json := coalesce(new.answer_json, '{}'::jsonb);
  new.answer_json := jsonb_set(new.answer_json, '{answer_text}', to_jsonb(new.answer_text), true);
  return new;
end;
$$;

drop trigger if exists trg_reorder_chat_report_answer_text on public.chat_reports;

create trigger trg_reorder_chat_report_answer_text
before insert or update of answer_text, answer_json on public.chat_reports
for each row
execute function public.reorder_chat_report_answer_text();

update public.chat_reports
set answer_text = public.put_substantive_report_body_first(answer_text)
where position('## 1. 結論' in answer_text) > 0
   or position('## 1 結論' in answer_text) > 0
   or position('## 結論' in answer_text) > 0;
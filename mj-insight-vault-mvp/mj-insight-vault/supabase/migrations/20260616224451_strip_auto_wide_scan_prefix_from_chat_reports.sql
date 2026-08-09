create or replace function public.strip_internal_report_prompt(value text)
returns text
language plpgsql
immutable
as $$
declare
  idx integer;
  cleaned text;
begin
  cleaned := coalesce(value, '');
  idx := position(E'\n\n【レポート要件】' in cleaned);
  if idx > 0 then
    cleaned := substring(cleaned from 1 for idx - 1);
  end if;
  idx := position('【レポート要件】' in cleaned);
  if idx > 0 then
    cleaned := substring(cleaned from 1 for idx - 1);
  end if;
  idx := position('最重要: answer_text' in cleaned);
  if idx > 0 then
    cleaned := substring(cleaned from 1 for idx - 1);
  end if;
  cleaned := regexp_replace(cleaned, '^\s*全記事を対象に、全データを広域スキャンしたうえで分析してください。[\s　]*', '', 'g');
  cleaned := regexp_replace(cleaned, '\s+', ' ', 'g');
  return btrim(cleaned);
end;
$$;

update public.chat_reports
set user_query = public.strip_internal_report_prompt(user_query)
where user_query like '全記事を対象に、全データを広域スキャンしたうえで分析してください。%'
   or user_query like '%【レポート要件】%'
   or user_query like '%最重要: answer_text%';

update public.chat_reports
set user_query = '分析指示未保存'
where coalesce(btrim(user_query), '') = '';

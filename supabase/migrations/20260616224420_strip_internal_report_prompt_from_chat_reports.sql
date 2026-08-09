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
  cleaned := regexp_replace(cleaned, '\s+', ' ', 'g');
  return btrim(cleaned);
end;
$$;

create or replace function public.clean_chat_report_user_query()
returns trigger
language plpgsql
as $$
begin
  new.user_query := public.strip_internal_report_prompt(new.user_query);
  if coalesce(new.user_query, '') = '' then
    new.user_query := '分析指示未保存';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clean_chat_report_user_query on public.chat_reports;

create trigger trg_clean_chat_report_user_query
before insert or update of user_query on public.chat_reports
for each row
execute function public.clean_chat_report_user_query();

update public.chat_reports
set user_query = public.strip_internal_report_prompt(user_query)
where user_query like '%【レポート要件】%'
   or user_query like '%最重要: answer_text%';

update public.chat_reports
set user_query = '分析指示未保存'
where coalesce(btrim(user_query), '') = '';

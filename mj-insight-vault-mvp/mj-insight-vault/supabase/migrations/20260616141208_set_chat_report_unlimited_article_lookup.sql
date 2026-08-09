create or replace function public.set_chat_report_unlimited_article_lookup()
returns trigger
language plpgsql
as $$
declare
  all_lookup jsonb;
  all_ids jsonb;
  active_count integer;
begin
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'article_id', a.id,
      'headline', coalesce(nullif(a.headline, ''), '無題の記事'),
      'article_date', coalesce(nullif(a.article_date, ''), '日付不明'),
      'article_url', '/articles/' || a.id::text,
      'article_link', '[' || coalesce(nullif(a.headline, ''), '無題の記事') || '｜' || coalesce(nullif(a.article_date, ''), '日付不明') || '](/articles/' || a.id::text || ')',
      'month_key', case
        when coalesce(a.article_date, '') ~ '^\d{4}-\d{1,2}' then regexp_replace(a.article_date, '^(\d{4})-(\d{1,2}).*$', '\1') || '-' || lpad(regexp_replace(a.article_date, '^\d{4}-(\d{1,2}).*$', '\1'), 2, '0')
        when coalesce(a.article_date, '') ~ '^\d{4}/\d{1,2}' then regexp_replace(a.article_date, '^(\d{4})/(\d{1,2}).*$', '\1') || '-' || lpad(regexp_replace(a.article_date, '^\d{4}/(\d{1,2}).*$', '\1'), 2, '0')
        when coalesce(a.article_date, '') ~ '^\d{4}年\s*\d{1,2}月' then regexp_replace(a.article_date, '^(\d{4})年\s*(\d{1,2})月.*$', '\1') || '-' || lpad(regexp_replace(a.article_date, '^\d{4}年\s*(\d{1,2})月.*$', '\1'), 2, '0')
        else 'undated'
      end
    ) order by coalesce(a.article_date, ''), a.created_at, a.id), '[]'::jsonb),
    coalesce(jsonb_agg(to_jsonb(a.id) order by coalesce(a.article_date, ''), a.created_at, a.id), '[]'::jsonb),
    count(*)::integer
  into all_lookup, all_ids, active_count
  from public.articles a
  where a.status is null or a.status not in ('deleted','excluded','rejected');

  new.related_article_ids := coalesce(new.related_article_ids, array[]::uuid[]);
  new.answer_json := coalesce(new.answer_json, '{}'::jsonb);
  new.answer_json := jsonb_set(new.answer_json, '{article_lookup}', all_lookup, true);
  new.answer_json := jsonb_set(new.answer_json, '{selected_article_ids}', all_ids, true);
  new.answer_json := jsonb_set(new.answer_json, '{article_count_for_report}', to_jsonb(active_count), true);
  new.answer_json := jsonb_set(new.answer_json, '{related_article_count}', to_jsonb(active_count), true);
  new.answer_json := jsonb_set(new.answer_json, '{root_article_count_unlimited}', to_jsonb(true), true);
  new.answer_json := jsonb_set(new.answer_json, '{root_article_lookup_count}', to_jsonb(active_count), true);
  new.answer_json := jsonb_set(new.answer_json, '{source_coverage,final_article_count}', to_jsonb(active_count), true);
  new.answer_json := jsonb_set(new.answer_json, '{source_coverage,root_article_lookup_count}', to_jsonb(active_count), true);
  new.answer_json := jsonb_set(new.answer_json, '{source_coverage,root_article_count_unlimited}', to_jsonb(true), true);
  new.answer_json := jsonb_set(new.answer_json, '{coverage_diagnosis,final_article_count}', to_jsonb(active_count), true);
  new.answer_json := jsonb_set(new.answer_json, '{coverage_diagnosis,root_article_lookup_count}', to_jsonb(active_count), true);
  new.answer_json := jsonb_set(new.answer_json, '{coverage_diagnosis,root_article_count_unlimited}', to_jsonb(true), true);

  new.answer_text := coalesce(new.answer_text, '');
  if position('## 0.0 システムカバレッジ（自動検証）' in new.answer_text) = 0 then
    new.answer_text := '## 0.0 システムカバレッジ（自動検証）' || E'\n'
      || '全件カバレッジ: ' || active_count::text || '件' || E'\n'
      || '根拠記事リスト: ' || active_count::text || '件（上限なし）' || E'\n'
      || '注記: LLMに個別本文として投入する記事数とは別です。分析母集団と根拠記事リストは全件です。' || E'\n\n'
      || new.answer_text;
  else
    new.answer_text := regexp_replace(
      new.answer_text,
      '根拠確認用記事数:\s*[0-9]+件',
      '根拠記事リスト: ' || active_count::text || '件（上限なし）',
      'g'
    );
  end if;
  new.answer_json := jsonb_set(new.answer_json, '{answer_text}', to_jsonb(new.answer_text), true);

  return new;
end;
$$;

drop trigger if exists trg_set_chat_report_unlimited_article_lookup on public.chat_reports;

create trigger trg_set_chat_report_unlimited_article_lookup
before insert or update of answer_json, answer_text on public.chat_reports
for each row
execute function public.set_chat_report_unlimited_article_lookup();
-- Keep report-analysis helper functions deterministic under the service role.
-- This changes only name resolution, not function behavior.
alter function public.clean_chat_report_user_query()
  set search_path = pg_catalog, public;

alter function public.match_articles(vector, integer)
  set search_path = pg_catalog, public;

alter function public.put_substantive_report_body_first(text)
  set search_path = pg_catalog, public;

alter function public.reorder_chat_report_answer_text()
  set search_path = pg_catalog, public;

alter function public.set_chat_report_unlimited_article_lookup()
  set search_path = pg_catalog, public;

alter function public.strip_internal_report_prompt(text)
  set search_path = pg_catalog, public;

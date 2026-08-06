-- articles.article_date is intentionally free-form text and includes Japanese date strings.
-- monthly_rollups must not force that source label through timestamptz parsing.

alter table public.monthly_rollups
  alter column source_latest_article_at type text
  using source_latest_article_at::text;

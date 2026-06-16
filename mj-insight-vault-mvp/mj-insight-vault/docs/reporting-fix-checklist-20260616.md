# Reporting fix checklist / 2026-06-16

## Current diagnosis

- Articles are stored: DB check showed 1,289 total articles and 1,249 active articles.
- Monthly rollups were effectively unavailable: only one monthly_rollups row existed, and it was stale.
- Full report generation cannot be reliable until monthly rollups are ready.

## Implemented direction

- Monthly rollup generation is bounded: at most 3 months per request.
- Monthly rollup generation has fallback behavior: if LLM generation fails, an extractive fallback rollup is saved as ready.
- Full reporting should use monthly rollups as the full-corpus analysis layer. Individual articles are evidence examples only.

## Operational rule

1. Open /rollups.
2. Run "必要な月だけ生成".
3. Re-run until needed months are zero and all months are ready.
4. Then run /chat full report.

## Remaining checks

- Verify Vercel success on the k5k2 project.
- Verify /rollups reports ready months correctly.
- Verify full report source_coverage shows monthly_rollup_used and monthly_rollup_source_article_count.

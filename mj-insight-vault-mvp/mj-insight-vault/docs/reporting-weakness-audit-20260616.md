# Reporting weakness audit / 2026-06-16

## Critical findings

1. Articles are accumulating correctly, but monthly rollups are not ready.
   - Current DB check showed more than 1,200 articles.
   - monthly_rollups had only one row and it was stale.
   - Therefore, full-corpus reporting had no usable monthly intelligence layer.

2. The previous rollup generation path was too large and too fragile.
   - A single request could try to generate multiple months sequentially.
   - Large months could include hundreds of articles.
   - This was vulnerable to Vercel max duration, OpenAI timeout, and huge prompt failures.

3. Failed monthly rollups blocked the whole reporting strategy.
   - If LLM rollup generation failed, the month stayed failed/stale.
   - Full report generation then either had no rollup context or became provisional.

4. The app needed a bounded, fallback-safe rollup layer.
   - Reporting should not depend on one huge all-corpus call.
   - Monthly rollups should be generated in bounded batches.
   - Even if LLM generation fails, a provisional extractive rollup should be saved so the pipeline can proceed.

## Implemented improvements

1. Bounded monthly generation
   - /api/rollups/monthly now processes at most 3 months per request.
   - needs_only, stale_only, and all are bounded.
   - This reduces timeout risk and avoids trying to regenerate the entire corpus in one request.

2. Fallback-safe monthly rollups
   - generateMonthlyRollup now uses shorter per-article text for large months.
   - If OpenAI is missing or all model attempts fail, the system saves an extractive fallback rollup as ready.
   - The fallback preserves all article IDs, representative article IDs, evidence article IDs, and a clear generation warning.

3. Full-corpus reporting layer
   - Full report generation should use monthly rollups as the primary full-corpus layer.
   - Individual articles are evidence examples, not the entire analysis universe.

## Remaining operational rule

Before running a full report, open /rollups and run "必要な月だけ生成" until all article months are ready. If some rollups are extractive_fallback, the full report is usable but should be treated as provisional for those months.

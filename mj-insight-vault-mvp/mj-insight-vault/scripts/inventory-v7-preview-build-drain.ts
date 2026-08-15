import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '../lib/articleInventoryWorkerV7GroundedOrchestrator';

const BRANCH = 'codex/full-corpus-report-production';
const MAX_STEPS = 40;
const LANES = 2;
const MAX_MS = 8 * 60 * 1000;

async function main() {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) {
    console.log(JSON.stringify({ inventory_v7_preview_build_drain: 'skipped_non_target', env: process.env.VERCEL_ENV || null, branch: process.env.VERCEL_GIT_COMMIT_REF || null }));
    return;
  }

  const startedAt = Date.now();
  let claimed = 0;
  let idleRounds = 0;
  const stages: Record<string, number> = {};

  for (let round = 1; round <= MAX_STEPS && Date.now() - startedAt < MAX_MS; round += 1) {
    const results = await Promise.all(Array.from({ length: LANES }, () => runArticleInventoryWorkerV7GroundedOrchestratorStep()));
    let roundClaims = 0;
    for (const step of results) {
      const stage = String((step as { stage?: unknown } | null)?.stage || 'idle');
      stages[stage] = (stages[stage] || 0) + 1;
      const c = Number((step as { claimed?: unknown } | null)?.claimed || 0);
      claimed += c;
      roundClaims += c;
      console.log(JSON.stringify({ inventory_v7_preview_build_drain: 'step', round, step }));
    }
    if (roundClaims === 0) {
      idleRounds += 1;
      if (idleRounds >= 2) break;
    } else {
      idleRounds = 0;
    }
  }

  console.log(JSON.stringify({ inventory_v7_preview_build_drain: 'done', claimed, stages, elapsed_ms: Date.now() - startedAt }));
}

main().catch((error) => {
  console.error(JSON.stringify({ inventory_v7_preview_build_drain: 'failed', error: error instanceof Error ? error.stack || error.message : String(error) }));
  process.exit(1);
});

import { spawnSync } from 'node:child_process';

const INVENTORY_DRAIN_BRANCH = 'agent/inventory-smoke-v2';
const INVENTORY_DRAIN_TICKET = 'inventory-v7-build-drain-20260813-b';

function runBoundedInventoryDrainDuringPreviewBuild() {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== INVENTORY_DRAIN_BRANCH) return;

  const workerProgram = String.raw`
(async () => {
  const ticketKey = process.env.MJ_INVENTORY_BUILD_TICKET || 'inventory-v7-build-drain-20260813-b';
  const required = ['OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.log(JSON.stringify({ inventory_build_drain: 'skipped_missing_env', missing }));
    return;
  }

  const [{ supabaseAdmin }, workerModule] = await Promise.all([
    import('./lib/supabaseAdmin.ts'),
    import('./lib/articleInventoryWorkerV7GroundedOrchestrator.ts')
  ]);
  const runStep = workerModule.runArticleInventoryWorkerV7GroundedOrchestratorStep;
  if (typeof runStep !== 'function') throw new Error('inventory_v7_worker_export_missing');

  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown-build-commit';
  const { data: claim, error: claimError } = await supabaseAdmin.rpc('claim_inventory_build_drain_ticket_v1', {
    p_ticket_key: ticketKey,
    p_commit_sha: commitSha
  });
  if (claimError) throw new Error('inventory_build_ticket_claim_failed:' + claimError.message);
  if (!claim?.claimed) {
    console.log(JSON.stringify({ inventory_build_drain: 'no_ticket', claim }));
    return;
  }

  const workers = Math.max(1, Math.min(4, Number(claim.workers || 2)));
  const activeMs = Math.max(30000, Math.min(600000, Number(claim.active_ms || 600000)));
  const freezeReceiptId = String(claim.freeze_receipt_id || '');
  const stopStartingAt = Date.now() + activeMs;

  async function lane(laneNo) {
    let claimedSteps = 0;
    let idle = false;
    let consecutiveErrors = 0;
    const stages = {};
    const errors = [];
    while (Date.now() < stopStartingAt) {
      try {
        const step = await runStep();
        const stage = String(step?.stage || 'idle');
        stages[stage] = (stages[stage] || 0) + 1;
        if (Number(step?.claimed || 0) < 1) {
          idle = true;
          break;
        }
        claimedSteps += 1;
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        errors.push(String(error?.message || error).slice(0, 500));
        if (consecutiveErrors >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    return { lane: laneNo, claimed_steps: claimedSteps, idle, stages, errors };
  }

  let result;
  let fatalError = null;
  try {
    const lanes = await Promise.all(Array.from({ length: workers }, (_, index) => lane(index + 1)));
    const { data: rows, error: rowsError } = await supabaseAdmin
      .from('source_page_article_inventory_jobs_v1')
      .select('status')
      .eq('freeze_receipt_id', freezeReceiptId)
      .eq('inventory_version', 'page_article_inventory_v4_recovered_ocr');
    if (rowsError) throw new Error('inventory_build_status_read_failed:' + rowsError.message);
    const counts = {};
    for (const row of rows || []) {
      const status = String(row.status || 'unknown');
      counts[status] = (counts[status] || 0) + 1;
    }
    result = {
      workers,
      active_ms: activeMs,
      claimed_steps: lanes.reduce((sum, item) => sum + item.claimed_steps, 0),
      lanes,
      counts
    };
  } catch (error) {
    fatalError = String(error?.message || error).slice(0, 2000);
    result = { workers, active_ms: activeMs, fatal_error: fatalError };
  }

  const { data: finish, error: finishError } = await supabaseAdmin.rpc('finish_inventory_build_drain_ticket_v1', {
    p_ticket_key: ticketKey,
    p_commit_sha: commitSha,
    p_result: result,
    p_error: fatalError
  });
  if (finishError) throw new Error('inventory_build_ticket_finish_failed:' + finishError.message);
  console.log(JSON.stringify({ inventory_build_drain: 'finished', finish, result }));
  if (fatalError) throw new Error(fatalError);
})().catch((error) => {
  console.error('inventory_build_drain_fatal', error?.stack || error);
  process.exit(1);
});
`;

  const child = spawnSync('npx', ['--yes', 'tsx@4.20.3', '-e', workerProgram], {
    cwd: process.cwd(),
    env: { ...process.env, MJ_INVENTORY_BUILD_TICKET: INVENTORY_DRAIN_TICKET },
    stdio: 'inherit',
    timeout: 900000
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`inventory build drain exited with status ${child.status}`);
}

runBoundedInventoryDrainDuringPreviewBuild();

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '25mb' }
  },
  images: { remotePatterns: [] }
};
export default nextConfig;

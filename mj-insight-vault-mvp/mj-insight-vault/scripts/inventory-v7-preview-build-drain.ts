import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '../lib/articleInventoryWorkerV7GroundedOrchestrator';
import { supabaseAdmin } from '../lib/supabaseAdmin';

const BRANCH = 'codex/full-corpus-report-production';
const MAX_STEPS = 240;
const LANES = 2;
const MAX_MS = 12 * 60 * 1000;

async function currentExceptions() {
  const { data: control, error: controlError } = await supabaseAdmin
    .from('inventory_v3_execution_control_v1')
    .select('freeze_receipt_id')
    .eq('singleton', true)
    .single();
  if (controlError) throw controlError;
  const freeze = String(control?.freeze_receipt_id || '');
  if (!freeze) throw new Error('Current inventory freeze missing.');
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('id,status,error_message')
    .eq('freeze_receipt_id', freeze)
    .in('status', ['needs_review', 'discovery_required', 'failed']);
  if (error) throw error;
  return data || [];
}

async function main() {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) {
    console.log(JSON.stringify({ inventory_v7_preview_build_drain: 'skipped_non_target', env: process.env.VERCEL_ENV || null, branch: process.env.VERCEL_GIT_COMMIT_REF || null }));
    return;
  }

  // The DB contract for formal grounded adjudication requires this exact model.
  // Pin it here so stale Preview environment values cannot downgrade adjudication.
  process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL = 'gpt-5.6-sol';

  const initialExceptions = await currentExceptions();
  if (initialExceptions.length) {
    console.log(JSON.stringify({ inventory_v7_preview_build_drain: 'stopped_existing_exception', exceptions: initialExceptions }));
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

    const exceptions = await currentExceptions();
    if (exceptions.length) {
      console.log(JSON.stringify({ inventory_v7_preview_build_drain: 'stopped_new_exception', round, claimed, exceptions }));
      break;
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

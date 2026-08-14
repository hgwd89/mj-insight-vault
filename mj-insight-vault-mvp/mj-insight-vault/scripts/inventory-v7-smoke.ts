import { supabaseAdmin } from '../lib/supabaseAdmin';
import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '../lib/articleInventoryWorkerV7GroundedOrchestrator';

const JOB_ID = '0018d849-75f9-460d-988d-4497e09d7b58';
const TERMINAL = new Set(['completed', 'needs_review', 'discovery_required', 'failed']);

async function readJob() {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('id,status,attempt_count,error_message,requires_third_pass,lease_expires_at,updated_at,finished_at')
    .eq('id', JOB_ID)
    .single();
  if (error) throw error;
  return data;
}

async function closeExecution(reason: string) {
  const { error } = await supabaseAdmin
    .from('inventory_v3_execution_control_v1')
    .update({ enabled: false, reason, updated_at: new Date().toISOString() })
    .eq('singleton', true);
  if (error) throw error;
}

async function main() {
  const before = await readJob();
  if (before.status !== 'queued' && !TERMINAL.has(String(before.status))) {
    throw new Error(`unexpected smoke job status before run: ${before.status}`);
  }

  const { data: seal, error: sealError } = await supabaseAdmin.rpc('seal_inventory_v3_execution_v2', {
    p_reason: 'github-actions one-job v7 smoke'
  });
  if (sealError) throw sealError;
  console.log(JSON.stringify({ phase: 'sealed', seal, before }));

  try {
    for (let i = 1; i <= 8; i += 1) {
      const current = await readJob();
      if (TERMINAL.has(String(current.status))) {
        console.log(JSON.stringify({ phase: 'terminal', iteration: i, current }));
        return;
      }
      const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep(JOB_ID);
      const after = await readJob();
      console.log(JSON.stringify({ phase: 'step', iteration: i, step, after }));
      if (TERMINAL.has(String(after.status))) return;
      if (Number((step as { claimed?: number } | null)?.claimed || 0) < 1) {
        throw new Error(`inventory v7 smoke failed to claim fixed job on iteration ${i}`);
      }
    }
    throw new Error('inventory v7 smoke exceeded 8 worker steps without terminal state');
  } finally {
    await closeExecution('closed after github-actions one-job v7 smoke');
    console.log(JSON.stringify({ phase: 'execution_closed', job: await readJob() }));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

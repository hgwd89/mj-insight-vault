import { supabaseAdmin } from '../lib/supabaseAdmin';
import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '../lib/articleInventoryWorkerV7GroundedOrchestrator';

const freezeId = process.env.INVENTORY_FREEZE_ID || '96b4d379-b33d-48be-91e4-d259b268a003';
const inventoryVersion = 'page_article_inventory_v4_recovered_ocr';
const workers = Math.max(1, Math.min(4, Number(process.env.INVENTORY_WORKERS || 4)));
const maxMinutes = Math.max(5, Math.min(50, Number(process.env.INVENTORY_MAX_MINUTES || 50)));
const deadline = Date.now() + maxMinutes * 60_000;

let stop = false;
let stopReason = '';
let claimedTotal = 0;
const stages: Record<string, number> = {};

async function snapshot() {
  const [{ data: jobs, error: jobsError }, { data: capture, error: captureError }] = await Promise.all([
    supabaseAdmin
      .from('source_page_article_inventory_jobs_v1')
      .select('page_identity_source_image_id,inventory_source_image_id,source_ocr_json_sha256,status,requires_third_pass,error_message')
      .eq('freeze_receipt_id', freezeId)
      .eq('inventory_version', inventoryVersion),
    supabaseAdmin
      .from('source_page_inventory_capture_v1')
      .select('page_identity_source_image_id,inventory_source_image_id,source_ocr_json_sha256'),
  ]);
  if (jobsError) throw new Error(jobsError.message);
  if (captureError) throw new Error(captureError.message);

  const currentKeys = new Set(
    (capture || []).map((row) =>
      `${String(row.page_identity_source_image_id)}:${String(row.inventory_source_image_id)}:${String(row.source_ocr_json_sha256)}`
    )
  );
  const currentJobs = (jobs || []).filter((row) =>
    currentKeys.has(
      `${String(row.page_identity_source_image_id)}:${String(row.inventory_source_image_id)}:${String(row.source_ocr_json_sha256)}`
    )
  );

  const counts: Record<string, number> = {};
  let dangerousReview = 0;
  for (const row of currentJobs) {
    const status = String(row.status || 'unknown');
    counts[status] = (counts[status] || 0) + 1;
    if (
      status === 'needs_review' &&
      /grounding guard|semantic correction|grounding violation/i.test(String(row.error_message || ''))
    ) dangerousReview += 1;
  }
  return { counts, dangerousReview, currentJobs: currentJobs.length, capturePages: currentKeys.size };
}

async function healthCheck() {
  const snap = await snapshot();
  if (snap.currentJobs !== snap.capturePages || snap.capturePages < 1) {
    stop = true;
    stopReason = `current_job_identity_mismatch=${snap.currentJobs}/${snap.capturePages}`;
  }
  const discovery = snap.counts.discovery_required || 0;
  const failed = snap.counts.failed || 0;
  if (!stop && discovery > 0) {
    stop = true;
    stopReason = `discovery_required=${discovery}`;
  } else if (!stop && failed > 0) {
    stop = true;
    stopReason = `failed=${failed}`;
  } else if (!stop && snap.dangerousReview > 0) {
    stop = true;
    stopReason = `dangerous_review=${snap.dangerousReview}`;
  }
  console.log(JSON.stringify({ event: 'health', claimed_total: claimedTotal, ...snap, stop, stop_reason: stopReason }));
  return snap;
}

async function lane(laneNo: number) {
  let claimed = 0;
  let idle = false;
  while (!stop && Date.now() < deadline) {
    const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep();
    const stage = String((step as { stage?: unknown }).stage || 'idle');
    stages[stage] = (stages[stage] || 0) + 1;
    const didClaim = Number((step as { claimed?: unknown }).claimed || 0);
    if (didClaim < 1) {
      idle = true;
      break;
    }
    claimed += 1;
    claimedTotal += 1;

    if (stage === 'grounded_v7_failed') {
      stop = true;
      stopReason = `lane_${laneNo}_${stage}`;
      break;
    }

    if (claimedTotal % 12 === 0) await healthCheck();
  }
  return { lane: laneNo, claimed, idle };
}

async function main() {
  console.log(JSON.stringify({ event: 'start', freeze_id: freezeId, inventory_version: inventoryVersion, workers, max_minutes: maxMinutes }));
  const before = await healthCheck();
  if (stop) throw new Error(`Inventory V7 drain blocked before start: ${stopReason}`);

  const lanes = await Promise.all(Array.from({ length: workers }, (_, i) => lane(i + 1)));
  const after = await healthCheck();
  console.log(JSON.stringify({
    event: 'finish',
    freeze_id: freezeId,
    inventory_version: inventoryVersion,
    workers,
    claimed_total: claimedTotal,
    stages,
    lanes,
    before,
    after,
    stop,
    stop_reason: stopReason,
  }));

  if (stop) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

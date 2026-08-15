import { createHash, timingSafeEqual } from 'node:crypto';
import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '@/lib/articleInventoryWorkerV7GroundedOrchestrator';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BRANCH = 'codex/full-corpus-report-production';
const NONCE_SHA256 = '91e495dfe26aed923586e0ba191d9ef309378840697d71bb0377fb269cfa4d36';
const RECOVERED_VERSION = 'page_article_inventory_v4_recovered_ocr';
const TERMINAL = new Set(['completed', 'needs_review', 'discovery_required', 'failed']);

function auth(req: Request) {
  if (process.env.VERCEL_GIT_COMMIT_REF !== BRANCH || process.env.VERCEL_ENV !== 'preview') return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJob(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('id,status,error_message,requires_third_pass,attempt_count,updated_at,finished_at')
    .eq('id', jobId)
    .single();
  if (error) throw error;
  return data;
}

async function recoveredStatus() {
  const [{ data: gate, error: gateError }, { data: jobs, error: jobsError }] = await Promise.all([
    supabaseAdmin.from('source_page_article_inventory_gate_v2').select('*').single(),
    supabaseAdmin.from('source_page_article_inventory_jobs_v1').select('status,requires_third_pass').eq('inventory_version', RECOVERED_VERSION)
  ]);
  if (gateError) throw gateError;
  if (jobsError) throw jobsError;
  const counts: Record<string, number> = {};
  for (const row of jobs || []) {
    const key = `${String(row.status || 'unknown')}:${row.requires_third_pass ? 'third' : 'normal'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return { gate, counts, worker_version: 'article_inventory_v7_grounded_orchestrator' };
}

async function runTargetJob(jobId: string, maxSteps: number) {
  const steps: unknown[] = [];
  for (let i = 1; i <= maxSteps; i += 1) {
    const before = await readJob(jobId);
    if (TERMINAL.has(String(before.status))) return { terminal: true, before, steps };
    const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep(jobId);
    steps.push({ i, step });
    const after = await readJob(jobId);
    if (TERMINAL.has(String(after.status))) return { terminal: true, after, steps };
    if (Number((step as { claimed?: unknown } | null)?.claimed || 0) < 1) return { terminal: false, after, steps, stopped: 'not_claimed' };
  }
  return { terminal: false, after: await readJob(jobId), steps, stopped: 'max_steps' };
}

async function drain(workers: number, activeMs: number) {
  const startedAt = Date.now();
  const stopStartingAt = startedAt + activeMs;
  async function runLane(lane: number) {
    const stages: Record<string, number> = {};
    let claimed = 0;
    let idle = false;
    while (Date.now() < stopStartingAt) {
      const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep();
      const stage = String((step as { stage?: unknown }).stage || 'idle');
      stages[stage] = (stages[stage] || 0) + 1;
      if (Number((step as { claimed?: unknown }).claimed || 0) < 1) {
        idle = true;
        break;
      }
      claimed += 1;
    }
    return { lane, claimed, idle, stages };
  }
  const lanes = await Promise.all(Array.from({ length: workers }, (_, index) => runLane(index + 1)));
  return {
    workers,
    active_ms: activeMs,
    elapsed_ms: Date.now() - startedAt,
    claimed_steps: lanes.reduce((sum, lane) => sum + lane.claimed, 0),
    lanes
  };
}

export async function GET(req: Request) {
  if (!auth(req)) return new Response('Not Found', { status: 404 });
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'recovered-status';
    if (action === 'job') {
      const jobId = url.searchParams.get('job_id') || '';
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) return Response.json({ error: 'invalid job_id' }, { status: 400 });
      const maxSteps = Math.max(1, Math.min(10, Number(url.searchParams.get('max_steps') || 8)));
      const result = await runTargetJob(jobId, maxSteps);
      return Response.json({ result, status: await recoveredStatus() }, { headers: { 'cache-control': 'no-store' } });
    }
    if (action === 'step') {
      const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep();
      return Response.json({ step, status: await recoveredStatus() }, { headers: { 'cache-control': 'no-store' } });
    }
    if (action === 'drain') {
      const workers = Math.max(1, Math.min(8, Number(url.searchParams.get('workers') || 2)));
      const activeMs = Math.max(30_000, Math.min(130_000, Number(url.searchParams.get('active_ms') || 120_000)));
      const result = await drain(workers, activeMs);
      return Response.json({ result, status: await recoveredStatus() }, { headers: { 'cache-control': 'no-store' } });
    }
    if (action === 'recovered-status') {
      return Response.json(await recoveredStatus(), { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'inventory v7 buildcheck error';
    return Response.json({ error: message }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

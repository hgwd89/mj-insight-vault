import { createHash, timingSafeEqual } from 'node:crypto';
import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '@/lib/articleInventoryWorkerV7GroundedOrchestrator';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BRANCH = 'codex/full-corpus-report-production';
const NONCE_SHA256 = '2bd58c543d9d8625c5dab4957d57a909f9db4d071977bf3942be8e08732e214b';
const RECOVERED_VERSION = 'page_article_inventory_v4_recovered_ocr';

function auth(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function currentStatus() {
  const [{ data: gate, error: gateError }, { data: jobs, error: jobsError }] = await Promise.all([
    supabaseAdmin.from('source_page_article_inventory_gate_v2').select('*').single(),
    supabaseAdmin.from('source_page_article_inventory_jobs_v1').select('status').eq('inventory_version', RECOVERED_VERSION)
  ]);
  if (gateError) throw gateError;
  if (jobsError) throw jobsError;
  const counts: Record<string, number> = {};
  for (const row of jobs || []) {
    const status = String(row.status || 'unknown');
    counts[status] = (counts[status] || 0) + 1;
  }
  return { gate, counts, worker_version: 'article_inventory_v7_grounded_orchestrator' };
}

export async function GET(req: Request) {
  if (!auth(req)) return new Response('Not Found', { status: 404 });
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'status';
    if (action === 'status') {
      return Response.json(await currentStatus(), { headers: { 'cache-control': 'no-store' } });
    }
    if (action === 'step') {
      const jobId = url.searchParams.get('job_id') || undefined;
      const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep(jobId);
      return Response.json({ step, status: await currentStatus() }, { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ error: 'unknown action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'inventory v7 preview smoke error';
    return Response.json({ error: message }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

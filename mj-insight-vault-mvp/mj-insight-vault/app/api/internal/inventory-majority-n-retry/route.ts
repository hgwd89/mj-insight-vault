import { createHash, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '@/lib/articleInventoryWorkerV7GroundedOrchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NONCE_SHA256 = '91e495dfe26aed923586e0ba191d9ef309378840697d71bb0377fb269cfa4d36';

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'production') return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found', { status: 404 });
  const prepared = await supabaseAdmin.rpc('prepare_inventory_majority_n_retry_v1');
  if (prepared.error) throw prepared.error;
  const payload = record(prepared.data);
  const jobId = String(payload.job_id || '');
  if (!jobId) {
    return Response.json({ prepared: payload, step: null, done: true }, { headers: { 'cache-control': 'no-store' } });
  }
  const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep(jobId);
  return Response.json({ prepared: payload, step }, { headers: { 'cache-control': 'no-store' } });
}

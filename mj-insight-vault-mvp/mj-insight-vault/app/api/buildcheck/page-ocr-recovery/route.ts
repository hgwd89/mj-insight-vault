import { createHash, timingSafeEqual } from 'node:crypto';
import { getSourcePageOcrRecoveryStatus, runSourcePageOcrRecoveryWorkerStep } from '@/lib/sourcePageOcrRecoveryWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BRANCH = 'agent/inventory-smoke-v2';
const NONCE_SHA256 = '91e495dfe26aed923586e0ba191d9ef309378840697d71bb0377fb269cfa4d36';
const MAX_CONCURRENCY = 16;
const DRAIN_ACTIVE_MS = 195_000;

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function drain() {
  const startedAt = Date.now();
  const stopStartingAt = startedAt + DRAIN_ACTIVE_MS;
  let claimed = 0;
  let externalCalls = 0;
  let idle = false;
  const sample: unknown[] = [];

  const runOne = async () => {
    const step = await runSourcePageOcrRecoveryWorkerStep();
    claimed += Number(step.claimed || 0);
    externalCalls += Number(step.external_calls || 0);
    if (sample.length < 12) sample.push(step);
    if (!step.claimed) idle = true;
    return step;
  };

  // Warm the Google OAuth token cache and prove one request works before high concurrency.
  const first = await runOne();
  if (!first.claimed) {
    return { claimed, external_calls: externalCalls, elapsed_ms: Date.now() - startedAt, idle: true, sample, status: await getSourcePageOcrRecoveryStatus() };
  }

  const worker = async () => {
    while (!idle && Date.now() < stopStartingAt) {
      const step = await runOne();
      if (!step.claimed) break;
    }
  };

  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, () => worker()));
  return {
    claimed,
    external_calls: externalCalls,
    elapsed_ms: Date.now() - startedAt,
    stopped_for_time_budget: !idle && Date.now() >= stopStartingAt,
    idle,
    sample,
    status: await getSourcePageOcrRecoveryStatus()
  };
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found', { status: 404 });
  const action = new URL(req.url).searchParams.get('action') || 'step';
  if (action === 'status') {
    return Response.json(await getSourcePageOcrRecoveryStatus(), { headers: { 'cache-control': 'no-store' } });
  }
  if (action === 'drain') {
    return Response.json(await drain(), { headers: { 'cache-control': 'no-store' } });
  }
  if (action !== 'step') return Response.json({ error: 'invalid action' }, { status: 400 });

  const step = await runSourcePageOcrRecoveryWorkerStep();
  const status = await getSourcePageOcrRecoveryStatus();
  return Response.json({ step, status }, { headers: { 'cache-control': 'no-store' } });
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { getSourcePageOcrRecoveryStatus, runSourcePageOcrRecoveryWorkerStep } from '@/lib/sourcePageOcrRecoveryWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BRANCH = 'agent/inventory-smoke-v2';
const NONCE_SHA256 = '91e495dfe26aed923586e0ba191d9ef309378840697d71bb0377fb269cfa4d36';

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== BRANCH) return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found', { status: 404 });
  const action = new URL(req.url).searchParams.get('action') || 'step';
  if (action === 'status') {
    return Response.json(await getSourcePageOcrRecoveryStatus(), { headers: { 'cache-control': 'no-store' } });
  }
  if (action !== 'step') return Response.json({ error: 'invalid action' }, { status: 400 });

  const step = await runSourcePageOcrRecoveryWorkerStep();
  const status = await getSourcePageOcrRecoveryStatus();
  return Response.json({ step, status }, { headers: { 'cache-control': 'no-store' } });
}

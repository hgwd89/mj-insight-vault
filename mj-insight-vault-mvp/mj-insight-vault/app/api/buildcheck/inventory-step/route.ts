import { createHash, timingSafeEqual } from 'node:crypto';
import { getArticleInventoryStatus, runArticleInventoryWorkerStep } from '@/lib/articleInventoryWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const EXPECTED_NONCE_SHA256 = 'a1a9193f8477327115f6b89946de7898280e61bcb867ec9d2c8d69168b8feecd';

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview') return false;
  if (process.env.VERCEL_GIT_COMMIT_REF !== 'audit/verified-pipeline-v10-buildcheck') return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(EXPECTED_NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found', { status: 404 });
  const jobId = new URL(req.url).searchParams.get('job_id')?.trim() || undefined;
  const step = await runArticleInventoryWorkerStep(jobId);
  return Response.json({ step, ...(await getArticleInventoryStatus()) }, { headers: { 'cache-control': 'no-store' } });
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '@/lib/articleInventoryWorkerV7GroundedOrchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NONCE_SHA256 = '91e495dfe26aed923586e0ba191d9ef309378840697d71bb0377fb269cfa4d36';
const INVENTORY_JOB_ID = '33abde71-6eca-485c-94bb-51205395c476';

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'production') return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found', { status: 404 });
  const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep(INVENTORY_JOB_ID);
  return Response.json({ inventory_job_id: INVENTORY_JOB_ID, step }, { headers: { 'cache-control': 'no-store' } });
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { runSourcePageInventoryRegionOcrRecoveryWorkerStep } from '@/lib/sourcePageInventoryRegionOcrRecoveryWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NONCE_SHA256 = '91e495dfe26aed923586e0ba191d9ef309378840697d71bb0377fb269cfa4d36';
const REGION_JOB_ID = '9640ace3-1c68-436b-9e3c-eb6fe2ce812c';

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'production') return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found', { status: 404 });
  const step = await runSourcePageInventoryRegionOcrRecoveryWorkerStep(REGION_JOB_ID);
  return Response.json({ step }, { headers: { 'cache-control': 'no-store' } });
}

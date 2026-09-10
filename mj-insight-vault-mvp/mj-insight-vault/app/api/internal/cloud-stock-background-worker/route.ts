import { after, NextRequest } from 'next/server';
import {
  backgroundWorkerToken,
  claimNextOcr,
  getOwnerNeonJwt,
  runClaimedOcr
} from '@/lib/cloudStockBackgroundOcr';

export const runtime = 'nodejs';
export const maxDuration = 180;

function authorized(req: NextRequest) {
  const expected = `Bearer ${backgroundWorkerToken()}`;
  return req.headers.get('authorization') === expected;
}

async function triggerNext(req: NextRequest) {
  const nextUrl = new URL('/api/internal/cloud-stock-background-worker', req.url);
  const response = await fetch(nextUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${backgroundWorkerToken()}` },
    cache: 'no-store'
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error('background OCR chaining failed', response.status, text.slice(0, 500));
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });

  after(async () => {
    try {
      const jwt = await getOwnerNeonJwt();
      const source = await claimNextOcr(jwt);
      if (!source) return;

      const sourceFileId = typeof source.id === 'string' ? source.id : '';
      try {
        await runClaimedOcr(jwt, source);
      } catch (error) {
        console.error('background OCR failed', sourceFileId, error);
      }
      await triggerNext(req);
    } catch (error) {
      console.error('background OCR worker stopped', error);
    }
  });

  return Response.json({ ok: true, accepted: true, mode: 'ocr_only_gpt_search' }, { status: 202 });
}

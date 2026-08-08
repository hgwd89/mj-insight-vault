import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getVerifiedArticleReviewStatus, runVerifiedArticleReviewWorkerStep } from '@/lib/verifiedArticleReviewWorker';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try { requireAppPassword(req); return Response.json(await getVerifiedArticleReviewStatus()); }
  catch (error) { return jsonError(error); }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runVerifiedArticleReviewWorkerStep();
    return Response.json({ step, ...(await getVerifiedArticleReviewStatus()) });
  } catch (error) { return jsonError(error); }
}

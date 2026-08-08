import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getVerifiedArticleClassificationStatus, runVerifiedArticleClassificationWorkerStep } from '@/lib/verifiedArticleClassificationWorker';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await getVerifiedArticleClassificationStatus());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runVerifiedArticleClassificationWorkerStep();
    return Response.json({ step, ...(await getVerifiedArticleClassificationStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

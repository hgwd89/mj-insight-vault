import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getArticleClassificationStatus, runArticleClassificationWorkerStep } from '@/lib/articleClassificationWorker';

export const runtime = 'nodejs';
export const maxDuration = 240;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const limit = Math.max(1, Math.min(6, Math.round(Number(body.limit || 6))));
    const step = await runArticleClassificationWorkerStep(limit);
    return Response.json({ step, ...(await getArticleClassificationStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

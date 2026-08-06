import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getArticleClassificationStatus } from '@/lib/articleClassificationWorker';
import { runSafeArticleClassificationWorkerStep } from '@/lib/articleClassificationWorkerSafe';

export const runtime = 'nodejs';
export const maxDuration = 240;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runSafeArticleClassificationWorkerStep();
    return Response.json({ step, ...(await getArticleClassificationStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getVerifiedArticleEmbeddingStatus, runVerifiedArticleEmbeddingWorkerStep } from '@/lib/verifiedArticleEmbeddingWorker';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await getVerifiedArticleEmbeddingStatus());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runVerifiedArticleEmbeddingWorkerStep();
    return Response.json({ step, ...(await getVerifiedArticleEmbeddingStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

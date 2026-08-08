import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getArticleInventoryStatus, runArticleInventoryWorkerStep } from '@/lib/articleInventoryWorker';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await getArticleInventoryStatus());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runArticleInventoryWorkerStep();
    return Response.json({ step, ...(await getArticleInventoryStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

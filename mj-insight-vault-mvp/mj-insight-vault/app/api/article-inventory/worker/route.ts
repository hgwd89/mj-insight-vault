import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getArticleInventoryStatus, runArticleInventoryWorkerStep } from '@/lib/articleInventoryWorker';

export const runtime = 'nodejs';
export const maxDuration = 240;

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
    // Exactly one worker step per HTTP request. A step performs at most one
    // external LLM call, then yields its lease before the response returns.
    const step = await runArticleInventoryWorkerStep();
    return Response.json({ step, ...(await getArticleInventoryStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

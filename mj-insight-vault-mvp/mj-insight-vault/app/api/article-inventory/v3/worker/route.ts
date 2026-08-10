import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getArticleInventoryV3Status, runArticleInventoryWorkerV3Step } from '@/lib/articleInventoryWorkerV3';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 240;

const noStore = { 'cache-control': 'no-store' };

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await getArticleInventoryV3Status(), { headers: noStore });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({})) as { job_id?: string };
    const step = await runArticleInventoryWorkerV3Step(body.job_id);
    return Response.json({ step, ...(await getArticleInventoryV3Status()) }, { headers: noStore });
  } catch (error) {
    return jsonError(error);
  }
}

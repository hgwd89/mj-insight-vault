import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getSourcePageOcrRecoveryStatus, runSourcePageOcrRecoveryWorkerStep } from '@/lib/sourcePageOcrRecoveryWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BRANCH = 'agent/inventory-smoke-v2';

function previewOnly() {
  return process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_GIT_COMMIT_REF === BRANCH;
}

export async function GET(req: NextRequest) {
  if (!previewOnly()) return new Response('Not Found', { status: 404 });
  try {
    requireAppPassword(req);
    return Response.json(await getSourcePageOcrRecoveryStatus(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  if (!previewOnly()) return new Response('Not Found', { status: 404 });
  try {
    requireAppPassword(req);
    const result = await runSourcePageOcrRecoveryWorkerStep();
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

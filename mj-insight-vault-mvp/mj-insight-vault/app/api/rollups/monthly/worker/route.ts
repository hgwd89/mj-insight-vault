import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { kickMonthlyRollupWorker, runMonthlyRollupWorkerStep } from '@/lib/monthlyRollupWorker';

export const runtime = 'nodejs';
export const maxDuration = 240;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const monthKey = text(body.month_key) || undefined;
    const result = await runMonthlyRollupWorkerStep(monthKey);
    let nextWorkerRequestId: unknown = null;
    let nextWorkerError = '';
    if (result.claimed && result.status !== 'lease_lost') {
      try {
        nextWorkerRequestId = await kickMonthlyRollupWorker();
      } catch (error) {
        nextWorkerError = error instanceof Error ? error.message : 'next monthly rollup worker kick failed';
      }
    }
    const status = result.status === 'failed' ? 422 : result.status === 'ready' ? 200 : 202;
    return Response.json({
      ...result,
      next_worker_request_id: nextWorkerRequestId,
      next_worker_error: nextWorkerError || null
    }, { status });
  } catch (error) {
    return jsonError(error);
  }
}

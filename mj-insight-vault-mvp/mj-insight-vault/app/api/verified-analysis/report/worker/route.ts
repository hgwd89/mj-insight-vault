import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { runVerifiedThemeReportStep } from '@/lib/verifiedAnalysisWorkerV8';

export const runtime = 'nodejs';
export const maxDuration = 240;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({})) as { source_job_id?: unknown };
    const sourceJobId = typeof body.source_job_id === 'string' ? body.source_job_id.trim() : '';
    if (!sourceJobId) throw new Error('source_job_id is required');
    const step = await runVerifiedThemeReportStep(sourceJobId);
    return Response.json({ step });
  } catch (error) {
    return jsonError(error);
  }
}

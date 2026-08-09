import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { runVerifiedDuplicateReviewStep } from '@/lib/verifiedAnalysisWorkerV8';

export const runtime = 'nodejs';
export const maxDuration = 240;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runVerifiedDuplicateReviewStep();
    return Response.json({ step });
  } catch (error) {
    return jsonError(error);
  }
}

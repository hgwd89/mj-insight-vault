import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getOcrVerificationStatus, runOcrVerificationWorkerStep } from '@/lib/ocrVerificationWorker';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await getOcrVerificationStatus());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runOcrVerificationWorkerStep();
    return Response.json({ step, ...(await getOcrVerificationStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

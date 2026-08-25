import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getOcrConsensusV11Status, runOcrConsensusV11Step } from '@/lib/ocrConsensusWorkerV11';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    return Response.json({ ok: true, result: await runOcrConsensusV11Step(), status: await getOcrConsensusV11Status() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, status: await getOcrConsensusV11Status() });
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getOcrConsensusSegmentV16Status, runOcrConsensusSegmentV16Step } from '@/lib/ocrConsensusSegmentWorkerV16';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, status: await getOcrConsensusSegmentV16Status() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const result = await runOcrConsensusSegmentV16Step();
    return Response.json({ ok: true, result, status: await getOcrConsensusSegmentV16Status() });
  } catch (error) {
    return jsonError(error);
  }
}

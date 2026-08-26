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
    // Two independent worker steps run concurrently. claim_ocr_consensus_canary_v16
    // uses FOR UPDATE SKIP LOCKED, so at most one step owns each canary page.
    // Each OpenAI request inside a step still receives exactly one segment image.
    const results = await Promise.all([
      runOcrConsensusSegmentV16Step(),
      runOcrConsensusSegmentV16Step()
    ]);
    return Response.json({ ok: true, results, status: await getOcrConsensusSegmentV16Status() });
  } catch (error) {
    return jsonError(error);
  }
}
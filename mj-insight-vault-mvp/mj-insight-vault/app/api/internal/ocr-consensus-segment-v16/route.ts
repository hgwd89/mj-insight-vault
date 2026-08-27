import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getOcrConsensusSegmentV16Status } from '@/lib/ocrConsensusSegmentWorkerV16';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, status: await getOcrConsensusSegmentV16Status(), execution: 'retired' });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    return Response.json({
      ok: false,
      status: 'retired',
      error: 'OCR consensus segment v16 execution is retired. Use /api/internal/ocr-consensus-piece-v18 after the current canary gate is satisfied.'
    }, { status: 410 });
  } catch (error) {
    return jsonError(error);
  }
}

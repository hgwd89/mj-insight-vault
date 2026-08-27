import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getOcrConsensusV11Status } from '@/lib/ocrConsensusWorkerV11';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    return Response.json({
      ok: false,
      status: 'retired',
      error: 'OCR consensus v11 execution is retired. Use /api/internal/ocr-consensus-piece-v18 after the current canary gate is satisfied.'
    }, { status: 410 });
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, status: await getOcrConsensusV11Status(), execution: 'retired' });
  } catch (error) {
    return jsonError(error);
  }
}

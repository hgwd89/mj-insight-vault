import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getOcrConsensusPieceV18Status, runOcrConsensusPieceV18Step } from '@/lib/ocrConsensusPieceWorkerV18';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, status: await getOcrConsensusPieceV18Status() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));

    // Keep one request below the Vercel function ceiling. Two independent piece
    // workers still run in parallel, but a second sequential round can push a
    // healthy provider call past the 180s route limit and discard completed work.
    const rounds = [await Promise.all([
      runOcrConsensusPieceV18Step(),
      runOcrConsensusPieceV18Step()
    ])];

    return Response.json({ ok: true, rounds, status: await getOcrConsensusPieceV18Status() });
  } catch (error) {
    return jsonError(error);
  }
}

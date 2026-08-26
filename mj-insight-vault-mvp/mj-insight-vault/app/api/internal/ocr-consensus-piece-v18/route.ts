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
    const results = await Promise.all([
      runOcrConsensusPieceV18Step(),
      runOcrConsensusPieceV18Step()
    ]);
    return Response.json({ ok: true, results, status: await getOcrConsensusPieceV18Status() });
  } catch (error) {
    return jsonError(error);
  }
}

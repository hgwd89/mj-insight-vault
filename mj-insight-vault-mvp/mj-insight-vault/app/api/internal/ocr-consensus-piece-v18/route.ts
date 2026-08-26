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

    const rounds = [];
    for (let round = 0; round < 2; round += 1) {
      const results = await Promise.all([
        runOcrConsensusPieceV18Step(),
        runOcrConsensusPieceV18Step()
      ]);
      rounds.push(results);
      if (results.every((result) => result.claimed === 0)) break;
    }

    return Response.json({ ok: true, rounds, status: await getOcrConsensusPieceV18Status() });
  } catch (error) {
    return jsonError(error);
  }
}

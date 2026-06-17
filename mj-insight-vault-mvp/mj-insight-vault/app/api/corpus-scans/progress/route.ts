import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { runFullCorpusScanBatches as advanceCorpusScan } from '@/lib/fullCorpusScan';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || '');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    const batchLimit = Math.max(1, Math.min(10, Math.round(Number(body.batch_limit || 2))));
    return Response.json(await advanceCorpusScan(id, batchLimit));
  } catch (error) {
    return jsonError(error);
  }
}

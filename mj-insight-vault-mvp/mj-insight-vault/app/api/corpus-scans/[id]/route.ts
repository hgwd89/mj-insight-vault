import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getFullCorpusScanRun } from '@/lib/fullCorpusScan';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const params = await ctx.params;
    const id = params.id || '';
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    return Response.json(await getFullCorpusScanRun(id));
  } catch (error) {
    return jsonError(error);
  }
}

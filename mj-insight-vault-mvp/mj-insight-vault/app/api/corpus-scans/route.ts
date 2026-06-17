import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { createFullCorpusScanRun, getLatestFullCorpusScanRun } from '@/lib/fullCorpusScan';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const url = new URL(req.url);
    const scopeType = url.searchParams.get('scope_type') || 'all';
    const scopeQuery = url.searchParams.get('scope_query') || '';
    const run = await getLatestFullCorpusScanRun(scopeType, scopeQuery);
    return Response.json({ run });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    return Response.json(await createFullCorpusScanRun({
      scope_type: body.scope_type,
      scope_query: body.scope_query,
      model: body.model,
      batch_size: body.batch_size
    }));
  } catch (error) {
    return jsonError(error);
  }
}

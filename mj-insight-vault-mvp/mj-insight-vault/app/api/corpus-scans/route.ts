import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { createFullCorpusScanRun, getFullCorpusScanRun, getLatestFullCorpusScanRun } from '@/lib/fullCorpusScan';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function createFormalAllRun(body: Record<string, unknown>) {
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : process.env.OPENAI_SCAN_MODEL || 'gpt-4o-mini';
  const requestedBatchSize = Number(body.batch_size || 30);
  const batchSize = Math.max(5, Math.min(50, Math.round(Number.isFinite(requestedBatchSize) ? requestedBatchSize : 30)));
  const { data, error } = await supabaseAdmin.rpc('create_formal_full_corpus_scan_v1', {
    p_model: model,
    p_batch_size: batchSize,
    p_prompt_version: 'full_corpus_batch_v2'
  });
  if (error) throw error;
  const runId = String((data as Record<string, unknown> | null)?.run_id || '');
  if (!runId) throw new Error('formal full corpus scan RPC returned no run_id');
  return getFullCorpusScanRun(runId);
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const url = new URL(req.url);
    const scopeType = url.searchParams.get('scope_type') || 'all';
    const scopeQuery = url.searchParams.get('scope_query') || '';
    const run = await getLatestFullCorpusScanRun(scopeType, scopeQuery);
    return Response.json({ run }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const scopeType = body.scope_type === 'category' ? 'category' : 'all';
    if (scopeType === 'all') {
      return Response.json(await createFormalAllRun(body), { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json(await createFullCorpusScanRun({
      scope_type: 'category',
      scope_query: typeof body.scope_query === 'string' ? body.scope_query : '',
      model: typeof body.model === 'string' ? body.model : undefined,
      batch_size: typeof body.batch_size === 'number' ? body.batch_size : undefined
    }), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

const STALE_RUNNING_MS = 90 * 1000;

type RouteContext = { params: Promise<{ id: string }> };

async function getParams(ctx: RouteContext) {
  return ctx.params;
}

function isStaleRunning(job: Record<string, unknown>) {
  if (job.status !== 'running') return false;
  const heartbeat = typeof job.heartbeat_at === 'string' ? Date.parse(job.heartbeat_at) : 0;
  if (!heartbeat || Number.isNaN(heartbeat)) return true;
  return Date.now() - heartbeat > STALE_RUNNING_MS;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    requireAppPassword(req);
    const { id } = await getParams(ctx);
    if (!id) return Response.json({ error: 'job id is required' }, { status: 400 });

    const { data, error } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', id).single();
    if (error) throw error;

    if (data && isStaleRunning(data)) {
      const { data: queued, error: updateError } = await supabaseAdmin.from('chat_jobs').update({
        status: 'queued',
        stage: '通信が中断された可能性があります。再開待ちです',
        progress: Math.max(5, Math.min(25, Number(data.progress || 5))),
        heartbeat_at: new Date().toISOString()
      }).eq('id', id).select('*').single();
      if (updateError) throw updateError;
      return Response.json({ job: queued, stale_recovered: true });
    }

    return Response.json({ job: data });
  } catch (error) {
    return jsonError(error);
  }
}

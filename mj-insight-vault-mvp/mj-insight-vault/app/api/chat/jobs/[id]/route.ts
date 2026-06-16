import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

const STALE_RUNNING_MS = 90 * 1000;

function hasSavedReport(job: Record<string, unknown>) {
  return Boolean(job.report_id || job.finished_at);
}

function isStaleRunning(job: Record<string, unknown>) {
  if (job.status !== 'running') return false;
  const heartbeat = typeof job.heartbeat_at === 'string' ? Date.parse(job.heartbeat_at) : 0;
  if (!heartbeat || Number.isNaN(heartbeat)) return true;
  return Date.now() - heartbeat > STALE_RUNNING_MS;
}

async function markCompleted(id: string, job: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.from('chat_jobs').update({
    status: 'completed',
    progress: 100,
    stage: 'レポート生成完了',
    error_message: null,
    finished_at: job.finished_at || new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const { id } = await params;
    if (!id) return Response.json({ error: 'job id is required' }, { status: 400 });

    const { data, error } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', String(id)).single();
    if (error) throw error;

    if (data && data.status !== 'completed' && hasSavedReport(data)) {
      const completed = await markCompleted(String(id), data);
      return Response.json({ job: completed, completed_recovered: true });
    }

    if (data && isStaleRunning(data)) {
      const { data: queued, error: updateError } = await supabaseAdmin.from('chat_jobs').update({
        status: 'queued',
        stage: '通信が中断された可能性があります。再開待ちです',
        progress: Math.max(5, Math.min(25, Number(data.progress || 5))),
        heartbeat_at: new Date().toISOString()
      }).eq('id', String(id)).select('*').single();
      if (updateError) throw updateError;
      return Response.json({ job: queued, stale_recovered: true });
    }

    return Response.json({ job: data });
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runChatAnalysis } from '@/lib/chatRouteCore';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

function clampProgress(value: unknown) {
  const progress = Math.round(Number(value));
  if (!Number.isFinite(progress)) return 1;
  return Math.max(1, Math.min(99, progress));
}

async function updateJob(id: string, patch: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from('chat_jobs').update({
    ...patch,
    heartbeat_at: new Date().toISOString()
  }).eq('id', id);
  if (error) throw error;
}

async function claimJob(id: string, job: Record<string, unknown>) {
  const startedPatch = {
    status: 'running',
    progress: isStaleRunning(job) ? Math.max(6, Math.min(20, Number(job.progress || 6))) : 6,
    stage: isStaleRunning(job) ? '停止した可能性がある分析を再開しました' : '分析を開始しました',
    error_message: null,
    started_at: job.started_at || new Date().toISOString(),
    finished_at: null,
    heartbeat_at: new Date().toISOString()
  };

  let query = supabaseAdmin
    .from('chat_jobs')
    .update(startedPatch)
    .eq('id', id)
    .eq('status', String(job.status || ''));

  if (typeof job.heartbeat_at === 'string') query = query.eq('heartbeat_at', job.heartbeat_at);

  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw error;
  if (data) return { job: data as Record<string, unknown>, claimed: true };

  const { data: latest, error: latestError } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', id).single();
  if (latestError) throw latestError;
  return { job: latest as Record<string, unknown>, claimed: false };
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    requireAppPassword(req);
    const { id } = await getParams(ctx);
    if (!id) return Response.json({ error: 'job id is required' }, { status: 400 });

    const { data: job, error: loadError } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', id).single();
    if (loadError) throw loadError;
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });

    if (job.status === 'completed') return Response.json({ job });
    if (job.status === 'failed') return Response.json({ job });
    if (job.status === 'running' && !isStaleRunning(job)) return Response.json({ job });

    const claimed = await claimJob(id, job);
    if (!claimed.claimed || claimed.job.status !== 'running') return Response.json({ job: claimed.job });
    let lastProgress = clampProgress(claimed.job.progress || job.progress || 1);

    try {
      const result = await runChatAnalysis(job.request_json || {}, async ({ progress, stage }) => {
        lastProgress = Math.max(lastProgress, clampProgress(progress));
        await updateJob(id, {
          status: 'running',
          progress: lastProgress,
          stage
        });
      });

      await updateJob(id, {
        status: 'completed',
        progress: 100,
        stage: 'レポート生成完了',
        result_json: result,
        report_id: result.report && typeof result.report === 'object' && 'id' in result.report ? String(result.report.id || '') : null,
        error_message: result.report_error || null,
        finished_at: new Date().toISOString()
      });

      const { data: completed } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', id).single();
      return Response.json({ job: completed, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'chat job failed';
      await updateJob(id, {
        status: 'failed',
        progress: 100,
        stage: '分析に失敗しました',
        error_message: message,
        finished_at: new Date().toISOString()
      });
      return Response.json({ error: message }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

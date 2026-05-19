import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runChatAnalysis } from '@/lib/chatRouteCore';

export const runtime = 'nodejs';
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

async function getParams(ctx: RouteContext) {
  return 'then' in ctx.params ? await ctx.params : ctx.params;
}

async function updateJob(id: string, patch: Record<string, unknown>) {
  await supabaseAdmin.from('chat_jobs').update({
    ...patch,
    heartbeat_at: new Date().toISOString()
  }).eq('id', id);
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
    if (job.status === 'running') return Response.json({ job });

    await updateJob(id, {
      status: 'running',
      progress: 6,
      stage: '分析を開始しました',
      error_message: null,
      started_at: job.started_at || new Date().toISOString()
    });

    try {
      const result = await runChatAnalysis(job.request_json || {}, async ({ progress, stage }) => {
        await updateJob(id, {
          status: 'running',
          progress: Math.max(1, Math.min(99, Math.round(progress))),
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

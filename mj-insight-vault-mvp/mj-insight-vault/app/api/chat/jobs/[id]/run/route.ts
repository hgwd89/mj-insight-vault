import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runChatAnalysis } from '@/lib/chatRouteNo160';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';

export const runtime = 'nodejs';
export const maxDuration = 300;

const STALE_RUNNING_MS = 90 * 1000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isStaleRunning(job: Record<string, unknown>) {
  if (job.status !== 'running') return false;
  const heartbeat = typeof job.heartbeat_at === 'string' ? Date.parse(job.heartbeat_at) : 0;
  if (!heartbeat || Number.isNaN(heartbeat)) return true;
  return Date.now() - heartbeat > STALE_RUNNING_MS;
}

function clampProgress(value: unknown) {
  return Math.max(1, Math.min(99, Math.round(Number(value) || 1)));
}

async function updateJob(id: string, patch: Record<string, unknown>) {
  await supabaseAdmin.from('chat_jobs').update({
    ...patch,
    heartbeat_at: new Date().toISOString()
  }).eq('id', id);
}

function reportIdFromResult(result: unknown) {
  if (!isRecord(result) || !isRecord(result.report)) return '';
  return text(result.report.id);
}

async function persistEnhancedReport(result: unknown) {
  if (!isRecord(result) || !isRecord(result.answer)) return;
  const reportId = reportIdFromResult(result);
  if (!reportId) return;
  await supabaseAdmin.from('chat_reports').update({
    answer_text: text(result.answer.answer_text) || JSON.stringify(result.answer),
    answer_json: result.answer
  }).eq('id', reportId);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const { id } = await params;
    if (!id) return Response.json({ error: 'job id is required' }, { status: 400 });
    const jobId = String(id);

    const { data: job, error: loadError } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
    if (loadError) throw loadError;
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });

    if (job.status === 'completed') return Response.json({ job });
    if (job.status === 'running' && !isStaleRunning(job)) return Response.json({ job });

    const initialProgress = isStaleRunning(job)
      ? Math.max(6, Math.min(20, Number(job.progress || 6)))
      : 6;
    let lastProgress = initialProgress;

    await updateJob(jobId, {
      status: 'running',
      progress: initialProgress,
      stage: isStaleRunning(job) ? '停止した可能性がある分析を再開しました' : '分析を開始しました',
      error_message: null,
      started_at: job.started_at || new Date().toISOString(),
      finished_at: null
    });

    try {
      await updateJob(jobId, { progress: Math.max(lastProgress, 12), stage: '月別まとめを確認中' });
      const request = isRecord(job.request_json) ? { ...job.request_json } : {};

      const rawResult = await runChatAnalysis(request, async ({ progress, stage }) => {
        const nextProgress = Math.max(lastProgress, clampProgress(progress));
        lastProgress = nextProgress;
        await updateJob(jobId, {
          status: 'running',
          progress: nextProgress,
          stage
        });
      });
      const result = enhanceChatAnalysisResult(rawResult);
      await persistEnhancedReport(result);
      const reportId = reportIdFromResult(result);
      const reportError = isRecord(result) ? text(result.report_error) : '';

      if (!reportId) {
        throw new Error(reportError ? `レポート保存に失敗しました: ${reportError}` : 'レポート保存に失敗しました。chat_reportsに保存されたreport_idがありません。');
      }

      await updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stage: 'レポート生成完了',
        result_json: result,
        report_id: reportId,
        error_message: reportError || null,
        finished_at: new Date().toISOString()
      });

      const { data: completed } = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
      return Response.json({ job: completed, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'chat job failed';
      await updateJob(jobId, {
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

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runChatAnalysis } from '@/lib/chatRouteFullCorpusGuard';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';

export const runtime = 'nodejs';
export const maxDuration = 300;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function reportIdFromResult(result: unknown) {
  if (!isRecord(result) || !isRecord(result.report)) return '';
  return text(result.report.id);
}

async function updateJob(id: string, patch: JsonRecord) {
  await supabaseAdmin.from('chat_jobs').update({
    ...patch,
    heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('id', id);
}

async function persistReport(result: unknown) {
  if (!isRecord(result) || !isRecord(result.answer)) return;
  const reportId = reportIdFromResult(result);
  if (!reportId) return;
  await supabaseAdmin.from('chat_reports').update({
    answer_text: text(result.answer.answer_text) || JSON.stringify(result.answer),
    answer_json: result.answer
  }).eq('id', reportId);
}

function progressValue(value: unknown, fallback: number) {
  return Math.max(1, Math.min(99, Math.round(Number(value) || fallback)));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const params = await ctx.params;
    const jobId = String(params.id || '');
    if (!jobId) return Response.json({ error: 'job id is required' }, { status: 400 });

    const loaded = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
    if (loaded.error) throw loaded.error;
    const job = loaded.data as JsonRecord;
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });

    if (job.status === 'completed') return Response.json({ job });
    if (job.report_id) {
      const completed = await supabaseAdmin.from('chat_jobs').update({ status: 'completed', progress: 100, stage: 'completed', finished_at: job.finished_at || new Date().toISOString() }).eq('id', jobId).select('*').single();
      if (completed.error) throw completed.error;
      return Response.json({ job: completed.data, completed_recovered: true });
    }

    let lastProgress = progressValue(job.progress, 6);
    await updateJob(jobId, { status: 'running', progress: lastProgress, stage: 'started', error_message: null, started_at: job.started_at || new Date().toISOString(), finished_at: null });

    try {
      const request = isRecord(job.request_json) ? { ...job.request_json } : {};
      const raw = await runChatAnalysis(request, async ({ progress, stage }) => {
        const next = Math.max(lastProgress, progressValue(progress, lastProgress));
        lastProgress = next;
        await updateJob(jobId, { status: 'running', progress: next, stage });
      });
      const result = enhanceChatAnalysisResult(raw);
      await persistReport(result);
      const reportId = reportIdFromResult(result);
      const reportError = isRecord(result) ? text(result.report_error) : '';
      if (!reportId) throw new Error(reportError || 'report was not saved');
      await updateJob(jobId, { status: 'completed', progress: 100, stage: 'completed', result_json: result, report_id: reportId, error_message: reportError || null, finished_at: new Date().toISOString() });
      const completed = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
      return Response.json({ job: completed.data, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'chat job failed';
      await updateJob(jobId, { status: 'failed', progress: 100, stage: 'failed', error_message: message, finished_at: new Date().toISOString() });
      return Response.json({ error: message }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

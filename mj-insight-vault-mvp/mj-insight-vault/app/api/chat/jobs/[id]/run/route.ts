import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runChatAnalysis } from '@/lib/chatRouteFullCorpusGuard';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';
import { prepareReportCorpus, type ReportPreparation } from '@/lib/reportPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function number(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function reportIdFromResult(result: unknown) {
  if (!isRecord(result) || !isRecord(result.report)) return '';
  return text(result.report.id);
}

async function updateJob(id: string, patch: JsonRecord) {
  const { error } = await supabaseAdmin.from('chat_jobs').update({
    ...patch,
    heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('id', id);
  if (error) throw error;
}

async function persistReport(result: unknown) {
  if (!isRecord(result) || !isRecord(result.answer)) return;
  const reportId = reportIdFromResult(result);
  if (!reportId) return;
  const safe = sanitizeReportForDisplay({
    user_query: '',
    answer_text: text(result.answer.answer_text) || JSON.stringify(result.answer),
    answer_json: result.answer
  });
  const { error } = await supabaseAdmin.from('chat_reports').update({
    answer_text: text(safe.answer_text),
    answer_json: safe.answer_json
  }).eq('id', reportId);
  if (error) throw error;
}

function progressValue(value: unknown, fallback: number) {
  return Math.max(1, Math.min(99, Math.round(Number(value) || fallback)));
}

function pipelineSnapshot(preparation: ReportPreparation) {
  const run = isRecord(preparation.context.run) ? preparation.context.run : {};
  return {
    required: preparation.required,
    ready: preparation.ready,
    terminal: preparation.terminal,
    scope: preparation.scope,
    progress: preparation.progress,
    stage: preparation.stage,
    error: preparation.error || null,
    created_new_run: preparation.created_new_run || false,
    gate: {
      full_corpus_gate: text(preparation.context.full_corpus_gate),
      gate_reason: text(preparation.context.gate_reason),
      current_article_count: number(preparation.context.current_article_count),
      current_article_count_diff: number(preparation.context.current_article_count_diff)
    },
    run: {
      id: text(run.id),
      status: text(run.status),
      scope_type: text(run.scope_type),
      scope_query: text(run.scope_query),
      active_article_count: number(run.active_article_count),
      ocr_ready_article_count: number(run.ocr_ready_article_count),
      total_batches: number(run.total_batches),
      completed_batches: number(run.completed_batches),
      failed_batches: number(run.failed_batches),
      needs_review_batches: number(run.needs_review_batches),
      analyzed_article_count: number(run.analyzed_article_count)
    }
  };
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
      const completed = await supabaseAdmin.from('chat_jobs').update({
        status: 'completed',
        progress: 100,
        stage: 'completed',
        finished_at: job.finished_at || new Date().toISOString()
      }).eq('id', jobId).select('*').single();
      if (completed.error) throw completed.error;
      return Response.json({ job: completed.data, completed_recovered: true });
    }

    let lastProgress = progressValue(job.progress, 6);
    await updateJob(jobId, {
      status: 'running',
      progress: lastProgress,
      stage: 'レポート前処理を開始',
      error_message: null,
      started_at: job.started_at || new Date().toISOString(),
      finished_at: null
    });

    try {
      const request = isRecord(job.request_json) ? { ...job.request_json } : {};
      const preparation = await prepareReportCorpus(request, 1);
      const preparationResult = { pipeline: pipelineSnapshot(preparation) };

      if (preparation.terminal) {
        const message = preparation.error || '本文読解の準備に失敗しました';
        await updateJob(jobId, {
          status: 'failed',
          progress: 100,
          stage: preparation.stage,
          result_json: preparationResult,
          report_id: null,
          error_message: message,
          finished_at: new Date().toISOString()
        });
        const failed = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
        return Response.json({ job: failed.data, pipeline: preparationResult.pipeline, error: message }, { status: 422 });
      }

      if (!preparation.ready) {
        lastProgress = Math.max(lastProgress, progressValue(preparation.progress, lastProgress));
        await updateJob(jobId, {
          status: 'queued',
          progress: lastProgress,
          stage: preparation.stage,
          result_json: preparationResult,
          report_id: null,
          error_message: null,
          finished_at: null
        });
        const queued = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
        return Response.json({ job: queued.data, pipeline: preparationResult.pipeline, pending: true }, { status: 202 });
      }

      lastProgress = Math.max(lastProgress, progressValue(preparation.progress, 64));
      await updateJob(jobId, {
        status: 'running',
        progress: lastProgress,
        stage: preparation.stage,
        result_json: preparationResult,
        error_message: null
      });

      const raw = await runChatAnalysis(request, async ({ progress, stage }) => {
        const next = Math.max(lastProgress, progressValue(progress, lastProgress));
        lastProgress = next;
        await updateJob(jobId, { status: 'running', progress: next, stage });
      });
      const result = enhanceChatAnalysisResult(raw);
      await persistReport(result);
      const reportId = reportIdFromResult(result);
      const reportError = isRecord(result) ? text(result.report_error) : '';

      if (!reportId) {
        const answer = isRecord(result) && isRecord(result.answer) ? result.answer : {};
        const gate = text(answer.full_corpus_gate);
        const qualityBlocked = reportError === 'formal_report_quality_gate_failed';
        const message = gate === 'failed'
          ? '本文読解ゲートが再確認時に失敗しました。記事追加などで母集団が変化した可能性があります。ジョブを再実行してください。'
          : qualityBlocked
            ? '品質ゲート未通過のため、正式レポートは保存していません。出力の不足項目を修正して再実行してください。'
            : reportError || 'report was not saved';
        await updateJob(jobId, {
          status: 'failed',
          progress: 100,
          stage: qualityBlocked ? 'quality_gate' : 'blocked',
          result_json: result,
          report_id: null,
          error_message: message,
          finished_at: new Date().toISOString()
        });
        const blocked = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
        return Response.json({ job: blocked.data, result, blocked: true, error: message }, { status: gate === 'failed' || qualityBlocked ? 409 : 500 });
      }

      await updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stage: 'completed',
        result_json: result,
        report_id: reportId,
        error_message: reportError || null,
        finished_at: new Date().toISOString()
      });
      const completed = await supabaseAdmin.from('chat_jobs').select('*').eq('id', jobId).single();
      return Response.json({ job: completed.data, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'chat job failed';
      await updateJob(jobId, {
        status: 'failed',
        progress: 100,
        stage: 'failed',
        error_message: message,
        finished_at: new Date().toISOString()
      });
      return Response.json({ error: message }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

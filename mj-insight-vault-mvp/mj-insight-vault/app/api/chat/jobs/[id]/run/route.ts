import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runChatAnalysis } from '@/lib/chatRouteFullCorpusGuard';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';
import { prepareReportCorpus, type ReportPreparation } from '@/lib/reportPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

const JOB_LEASE_SECONDS = 360;
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 4;

type JsonRecord = Record<string, unknown>;

class LeaseLostError extends Error {
  constructor() {
    super('report job lease lost');
    this.name = 'LeaseLostError';
  }
}

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

function errorRecord(error: unknown) {
  return isRecord(error) ? error : {};
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const record = errorRecord(error);
  return text(record.message || record.error || 'chat job failed');
}

function retryableError(error: unknown) {
  const record = errorRecord(error);
  const status = number(record.status || record.statusCode);
  const code = text(record.code).toLowerCase();
  const message = errorMessage(error).toLowerCase();
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (['etimedout', 'econnreset', 'econnrefused', 'enotfound'].includes(code)) return true;
  return message.includes('rate limit')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('temporarily unavailable')
    || message.includes('fetch failed')
    || message.includes('network');
}

function qualityGateError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes('final writer validation failed')
    || message.includes('theme analysis validation failed')
    || message.includes('evidence critic validation failed')
    || message.includes('semantic review failed')
    || message.includes('semantic review json invalid');
}

function retryDelaySeconds(failureCount: number) {
  return Math.min(300, 20 * Math.pow(2, Math.max(0, failureCount - 1)));
}

function reportIdFromResult(result: unknown) {
  if (!isRecord(result) || !isRecord(result.report)) return '';
  return text(result.report.id);
}

function compactCompletedJobResult(result: unknown, reportId: string) {
  const root = isRecord(result) ? result : {};
  const answer = isRecord(root.answer)
    ? root.answer
    : isRecord(root.answer_json)
      ? root.answer_json
      : {};
  const answerText = text(answer.answer_text || root.answer_text || answer.summary || answer.report_title);
  return {
    answer: {
      report_title: text(answer.report_title) || 'レポート',
      answer_text: answerText.slice(0, 180)
    },
    report: { id: reportId }
  };
}

async function loadJob(id: string) {
  const loaded = await supabaseAdmin.from('chat_jobs').select('*').eq('id', id).single();
  if (loaded.error) throw loaded.error;
  return loaded.data as JsonRecord;
}

async function claimJob(id: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_chat_job', {
    p_job_id: id,
    p_lease_seconds: JOB_LEASE_SECONDS
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return isRecord(row) ? row : null;
}

async function findSavedFormalReport(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('chat_reports')
    .select('id, answer_text, answer_json, created_at, is_formal_report, analysis_verification_status, full_corpus_gate')
    .eq('source_job_id', jobId)
    .eq('is_formal_report', true)
    .eq('analysis_verification_status', 'verified')
    .eq('full_corpus_gate', 'passed')
    .maybeSingle();
  if (error) throw error;
  return isRecord(data) ? data : null;
}

async function updateClaimedJob(id: string, leaseToken: string, patch: JsonRecord, releaseLease = false) {
  const now = new Date();
  const payload: JsonRecord = {
    ...patch,
    heartbeat_at: now.toISOString(),
    updated_at: now.toISOString(),
    lease_expires_at: releaseLease ? null : new Date(now.getTime() + JOB_LEASE_SECONDS * 1000).toISOString()
  };
  if (releaseLease) payload.lease_token = null;

  const { data, error } = await supabaseAdmin
    .from('chat_jobs')
    .update(payload)
    .eq('id', id)
    .eq('lease_token', leaseToken)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new LeaseLostError();
  return data as JsonRecord;
}

async function persistReport(result: unknown, sourceJobId: string) {
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
    answer_json: safe.answer_json,
    source_job_id: sourceJobId
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
      current_article_count_diff: number(preparation.context.current_article_count_diff),
      retryable_batches: number(preparation.context.retryable_batches),
      terminal_batches: number(preparation.context.terminal_batches)
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

    const claimed = await claimJob(jobId);
    if (!claimed) {
      const current = await loadJob(jobId);
      if (current.status === 'completed') return Response.json({ job: current });
      if (current.report_id) {
        const completed = await supabaseAdmin.from('chat_jobs').update({
          status: 'completed',
          progress: 100,
          stage: 'completed',
          attempt_count: 0,
          finished_at: current.finished_at || new Date().toISOString(),
          lease_token: null,
          lease_expires_at: null,
          next_retry_at: null
        }).eq('id', jobId).select('*').single();
        if (completed.error) throw completed.error;
        return Response.json({ job: completed.data, completed_recovered: true });
      }
      return Response.json({ job: current, already_claimed_or_delayed: true }, { status: 202 });
    }

    const leaseToken = text(claimed.lease_token);
    if (!leaseToken) throw new Error('claim_chat_job returned no lease token');
    const consecutiveFailureCount = Math.max(0, number(claimed.attempt_count));
    let lastProgress = progressValue(claimed.progress, 6);

    await updateClaimedJob(jobId, leaseToken, {
      status: 'running',
      progress: lastProgress,
      stage: 'レポート前処理を開始',
      error_message: null,
      finished_at: null
    });

    try {
      const savedReport = await findSavedFormalReport(jobId);
      if (savedReport) {
        const completed = await updateClaimedJob(jobId, leaseToken, {
          status: 'completed',
          progress: 100,
          stage: '保存済み正式レポートを復旧',
          result_json: compactCompletedJobResult(savedReport, text(savedReport.id)),
          report_id: text(savedReport.id),
          error_message: null,
          attempt_count: 0,
          finished_at: new Date().toISOString(),
          next_retry_at: null
        }, true);
        return Response.json({ job: completed, report: savedReport, completed_recovered: true });
      }

      const request = isRecord(claimed.request_json) ? { ...claimed.request_json, source_job_id: jobId } : { source_job_id: jobId };
      const preparation = await prepareReportCorpus(request, 1);
      const preparationResult = { pipeline: pipelineSnapshot(preparation) };

      if (preparation.terminal) {
        const message = preparation.error || '本文読解の準備に失敗しました';
        const failed = await updateClaimedJob(jobId, leaseToken, {
          status: 'failed',
          progress: 100,
          stage: preparation.stage,
          result_json: preparationResult,
          report_id: null,
          error_message: message,
          finished_at: new Date().toISOString(),
          next_retry_at: null
        }, true);
        return Response.json({ job: failed, pipeline: preparationResult.pipeline, error: message }, { status: 422 });
      }

      if (!preparation.ready) {
        lastProgress = Math.max(lastProgress, progressValue(preparation.progress, lastProgress));
        const queued = await updateClaimedJob(jobId, leaseToken, {
          status: 'queued',
          progress: lastProgress,
          stage: preparation.stage,
          result_json: preparationResult,
          report_id: null,
          error_message: null,
          attempt_count: 0,
          finished_at: null,
          next_retry_at: preparation.context.next_retry_at || null
        }, true);
        return Response.json({ job: queued, pipeline: preparationResult.pipeline, pending: true }, { status: 202 });
      }

      lastProgress = Math.max(lastProgress, progressValue(preparation.progress, 64));
      await updateClaimedJob(jobId, leaseToken, {
        status: 'running',
        progress: lastProgress,
        stage: preparation.stage,
        result_json: preparationResult,
        error_message: null,
        attempt_count: 0
      });

      const raw = await runChatAnalysis(request, async ({ progress, stage }) => {
        const next = Math.max(lastProgress, progressValue(progress, lastProgress));
        lastProgress = next;
        await updateClaimedJob(jobId, leaseToken, { status: 'running', progress: next, stage });
      });
      const result = enhanceChatAnalysisResult(raw);
      await persistReport(result, jobId);
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
        const blocked = await updateClaimedJob(jobId, leaseToken, {
          status: 'failed',
          progress: 100,
          stage: qualityBlocked ? 'quality_gate' : 'blocked',
          result_json: result,
          report_id: null,
          error_message: message,
          finished_at: new Date().toISOString(),
          next_retry_at: null
        }, true);
        return Response.json({ job: blocked, result, blocked: true, error: message }, { status: gate === 'failed' || qualityBlocked ? 409 : 500 });
      }

      const completed = await updateClaimedJob(jobId, leaseToken, {
        status: 'completed',
        progress: 100,
        stage: 'completed',
        result_json: compactCompletedJobResult(result, reportId),
        report_id: reportId,
        error_message: reportError || null,
        attempt_count: 0,
        finished_at: new Date().toISOString(),
        next_retry_at: null
      }, true);
      return Response.json({ job: completed, result });
    } catch (error) {
      if (error instanceof LeaseLostError) {
        const current = await loadJob(jobId);
        return Response.json({ job: current, error: error.message }, { status: 409 });
      }

      const message = errorMessage(error);
      const nextFailureCount = consecutiveFailureCount + 1;
      if (qualityGateError(error)) {
        const failed = await updateClaimedJob(jobId, leaseToken, {
          status: 'failed',
          progress: 100,
          stage: 'quality_gate',
          error_message: message,
          attempt_count: consecutiveFailureCount,
          finished_at: new Date().toISOString(),
          next_retry_at: null
        }, true);
        return Response.json({ job: failed, blocked: true, error: message }, { status: 409 });
      }
      if (retryableError(error) && nextFailureCount <= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
        const delaySeconds = retryDelaySeconds(nextFailureCount);
        const queued = await updateClaimedJob(jobId, leaseToken, {
          status: 'queued',
          progress: Math.max(5, Math.min(96, lastProgress)),
          stage: `一時エラーのため${delaySeconds}秒後に再試行します`,
          error_message: message,
          attempt_count: nextFailureCount,
          finished_at: null,
          next_retry_at: new Date(Date.now() + delaySeconds * 1000).toISOString()
        }, true);
        return Response.json({ job: queued, retry_scheduled: true, retry_after_seconds: delaySeconds }, { status: 202 });
      }

      const failed = await updateClaimedJob(jobId, leaseToken, {
        status: 'failed',
        progress: 100,
        stage: 'failed',
        error_message: message,
        attempt_count: nextFailureCount,
        finished_at: new Date().toISOString(),
        next_retry_at: null
      }, true);
      return Response.json({ job: failed, error: message }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

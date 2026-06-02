import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runChatAnalysis } from '@/lib/chatRouteNo160';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { buildMonthlyRollupContext } from '@/lib/monthlyRollupContext';

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

function wantsAllScope(request: JsonRecord) {
  return text(request.target_scope || 'all') === 'all';
}

async function updateJob(id: string, patch: Record<string, unknown>) {
  await supabaseAdmin.from('chat_jobs').update({
    ...patch,
    heartbeat_at: new Date().toISOString()
  }).eq('id', id);
}

async function prepareRequestWithMonthlyRollups(rawRequest: unknown) {
  const request = isRecord(rawRequest) ? { ...rawRequest } : {};
  if (!wantsAllScope(request)) return { request, monthlyContext: null as JsonRecord | null };

  const context = await buildMonthlyRollupContext();
  if (!context.has_rollups || !context.context_text) return { request, monthlyContext: null as JsonRecord | null };

  const previousConversation = Array.isArray(request.conversation) ? request.conversation : [];
  const rollupMessage = [
    '【MONTHLY_ROLLUP_CONTEXT】',
    '全体分析では、まず以下の月別まとめを一次入力として横断してください。',
    '生記事はストックとして残しつつ、長期傾向は月別rollupを優先して読んでください。',
    'ただし、月別まとめで落ちた小さな兆しがある可能性は限界として明記してください。',
    `rollup_count: ${context.rollup_count}`,
    `rollup_source_article_count: ${context.article_count}`,
    context.context_text
  ].join('\n');

  request.conversation = [
    ...previousConversation,
    { role: 'user', content: rollupMessage }
  ];
  request.monthly_rollup_context = {
    has_rollups: true,
    rollup_count: context.rollup_count,
    rollup_source_article_count: context.article_count,
    representative_article_ids: context.representative_article_ids,
    evidence_article_ids: context.evidence_article_ids
  };

  return { request, monthlyContext: request.monthly_rollup_context as JsonRecord };
}

function attachMonthlyMetadata(result: unknown, monthlyContext: JsonRecord | null) {
  if (!monthlyContext || !isRecord(result)) return result;
  const answer = isRecord(result.answer) ? { ...result.answer } : {};
  const sourceCoverage = isRecord(answer.source_coverage) ? { ...answer.source_coverage } : {};
  const coverageDiagnosis = isRecord(answer.coverage_diagnosis) ? { ...answer.coverage_diagnosis } : {};

  const monthlyCoverage = {
    monthly_rollup_used: true,
    monthly_rollup_count: monthlyContext.rollup_count,
    monthly_rollup_source_article_count: monthlyContext.rollup_source_article_count,
    representative_article_ids_from_rollups: monthlyContext.representative_article_ids,
    evidence_article_ids_from_rollups: monthlyContext.evidence_article_ids,
    monthly_rollup_note: '全体分析では月別rollupを一次入力として使用し、生記事は代表記事・補助根拠として扱います。記事ストック自体は削除・制限していません。'
  };

  return {
    ...result,
    answer: {
      ...answer,
      monthly_rollup_context: monthlyCoverage,
      source_coverage: { ...sourceCoverage, ...monthlyCoverage },
      coverage_diagnosis: { ...coverageDiagnosis, ...monthlyCoverage }
    }
  };
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
      const { request, monthlyContext } = await prepareRequestWithMonthlyRollups(job.request_json || {});

      const rawResult = await runChatAnalysis(request, async ({ progress, stage }) => {
        const nextProgress = Math.max(lastProgress, clampProgress(progress));
        lastProgress = nextProgress;
        await updateJob(jobId, {
          status: 'running',
          progress: nextProgress,
          stage
        });
      });
      const result = enhanceChatAnalysisResult(attachMonthlyMetadata(rawResult, monthlyContext));
      await persistEnhancedReport(result);

      await updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stage: 'レポート生成完了',
        result_json: result,
        report_id: reportIdFromResult(result) || null,
        error_message: isRecord(result) ? text(result.report_error) || null : null,
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

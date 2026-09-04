import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { requireNeonJwt } from '@/lib/neonCloud';
import { createReport, getJob, patchJob } from '@/lib/neonReportStore';
import { runNeonReportAnalysis } from '@/lib/neonReportAnalysis';

export const runtime = 'nodejs';
export const maxDuration = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const { id } = await ctx.params;
    const jobId = text(id);
    if (!jobId) return Response.json({ error: 'job id is required' }, { status: 400 });

    let job = await getJob(jwt, jobId);
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });
    if (job.status === 'completed') return Response.json({ job });
    if (job.status === 'running') return Response.json({ job, already_running: true }, { status: 202 });

    job = await patchJob(jwt, jobId, {
      status: 'running', progress: 8, stage: 'Neon記事本文を読み込んでいます',
      error_message: null, started_at: job.started_at || new Date().toISOString(), finished_at: null
    }) || job;

    try {
      const request = isRecord(job.request_json) ? job.request_json : { query: job.user_query };
      await patchJob(jwt, jobId, { progress: 20, stage: '記事本文をバッチ分析しています' });
      const result = await runNeonReportAnalysis(jwt, request);
      await patchJob(jwt, jobId, { progress: 88, stage: '最終レポートを保存しています' });

      const report = await createReport(jwt, {
        user_query: text(job.user_query || request.query),
        answer_text: text(result.answer.answer_text),
        answer_json: result.answer,
        related_article_ids: result.relatedArticleIds,
        report_kind: 'neon_native',
        is_formal_report: false,
        analysis_verification_status: 'neon_native',
        hidden: false,
        pinned: false,
        user_id: text(job.user_id) || 'owner'
      });
      if (!report) throw new Error('レポート保存結果が返りませんでした。');

      const completed = await patchJob(jwt, jobId, {
        status: 'completed', progress: 100, stage: 'レポート生成完了',
        report_id: report.id,
        result_json: {
          answer: {
            report_title: text(result.answer.report_title) || 'レポート',
            answer_text: text(result.answer.answer_text).slice(0, 180)
          },
          report: { id: report.id }
        },
        error_message: null,
        finished_at: new Date().toISOString(),
        next_retry_at: null
      }) || job;
      return Response.json({ job: completed, result: { answer: result.answer, report } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'レポート生成に失敗しました。';
      const failed = await patchJob(jwt, jobId, {
        status: 'failed', progress: 100, stage: '分析に失敗しました',
        error_message: message, finished_at: new Date().toISOString(), next_retry_at: null,
        attempt_count: Number(job.attempt_count || 0) + 1
      }) || job;
      return Response.json({ job: failed, error: message }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

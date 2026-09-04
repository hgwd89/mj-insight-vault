import { NextRequest } from 'next/server';
import { start } from 'workflow/api';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { createJob, latestActiveJob, patchJob } from '@/lib/neonReportStore';
import { requireNeonJwt } from '@/lib/neonCloud';
import { neonReportWorkflow } from '@/workflows/neon-report';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_QUERY_CHARS = 12_000;
const PIPELINE_VERSION = 'neon_report_pipeline_v2_durable';

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function activeJobResponse(job: unknown) {
  return Response.json({
    error: '未完了のレポートジョブがあります。完了または停止を確認してから新しいジョブを開始してください。',
    job,
    active_job_exists: true
  }, { status: 409 });
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const url = new URL(req.url);
    if (url.searchParams.get('active') !== '1') return Response.json({ error: 'active=1 is required' }, { status: 400 });
    return Response.json({ job: await latestActiveJob(jwt) || null });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const raw = await req.json() as Record<string, unknown>;
    const query = text(raw.query);
    if (!query) return Response.json({ error: 'query is required' }, { status: 400 });
    if (query.length > MAX_QUERY_CHARS) return Response.json({ error: `query is too long; maximum is ${MAX_QUERY_CHARS} characters` }, { status: 413 });

    const active = await latestActiveJob(jwt);
    if (active) return activeJobResponse(active);

    const request = {
      ...raw,
      query,
      target_scope: 'all',
      category_id: undefined,
      pipeline_version: PIPELINE_VERSION,
      source_store: 'neon',
      durable_workflow: true
    };
    let job = await createJob(jwt, request, query);
    if (!job) throw new Error('レポートジョブを作成できませんでした。');

    try {
      job = await patchJob(jwt, text(job.id), {
        status: 'running',
        progress: 5,
        stage: 'Durable Workflowを開始しています',
        error_message: null,
        started_at: new Date().toISOString(),
        finished_at: null
      }) || job;
      const run = await start(neonReportWorkflow, [text(job.id)]);
      return Response.json({ job, workflow_run_id: run.runId, durable_workflow: true, can_close_app: true }, { status: 202 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Durable Workflowを開始できませんでした。';
      await patchJob(jwt, text(job.id), {
        status: 'failed', progress: 100, stage: 'Workflow開始に失敗しました', error_message: message, finished_at: new Date().toISOString()
      });
      throw error;
    }
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { start } from 'workflow/api';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { requireNeonJwt } from '@/lib/neonCloud';
import { getJob, patchJob } from '@/lib/neonReportStore';
import { neonReportWorkflow } from '@/workflows/neon-report';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
    if (job.status === 'running') return Response.json({ job, already_running: true, durable_workflow: true }, { status: 202 });

    job = await patchJob(jwt, jobId, {
      status: 'running',
      progress: Math.max(5, Math.min(80, Number(job.progress || 5))),
      stage: 'Durable Workflowを再開しています',
      error_message: null,
      started_at: job.started_at || new Date().toISOString(),
      finished_at: null,
      next_retry_at: null
    }) || job;

    const run = await start(neonReportWorkflow, [jobId]);
    return Response.json({ job, workflow_run_id: run.runId, durable_workflow: true, can_close_app: true }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}

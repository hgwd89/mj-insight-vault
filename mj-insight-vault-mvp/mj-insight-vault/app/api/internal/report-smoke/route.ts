import { NextRequest } from 'next/server';
import { start } from 'workflow/api';
import { getOwnerNeonJwt } from '@/lib/cloudStockBackgroundOcr';
import { createJob, getJob, getReport, latestActiveJob, patchJob } from '@/lib/neonReportStore';
import { neonReportWorkflow } from '@/workflows/neon-report';

export const runtime = 'nodejs';

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export async function GET(req: NextRequest) {
  if (process.env.VERCEL_ENV === 'production') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const jwt = await getOwnerNeonJwt();
    const url = new URL(req.url);
    const jobId = text(url.searchParams.get('id'));

    if (jobId) {
      const job = await getJob(jwt, jobId);
      if (!job) return Response.json({ error: 'job not found' }, { status: 404 });
      const reportId = text(job.report_id);
      const report = reportId ? await getReport(jwt, reportId) : null;
      return Response.json({ job, report });
    }

    const active = await latestActiveJob(jwt);
    if (active) return Response.json({ active_job_exists: true, job: active }, { status: 409 });

    const query = '化粧品のトレンドを分析';
    const request = {
      query,
      model: 'gpt-5',
      target_scope: 'all',
      output_template: 'auto',
      source_store: 'neon',
      require_full_corpus: true,
      pipeline_version: 'neon_report_pipeline_v2_durable',
      smoke_test: true,
      report_requirements: 'AAAAレベルで、生活者ナラティブ、WHY3層、競合仮説、示唆、根拠マトリクス、反証・限界まで詳細に分析する。'
    };
    let job = await createJob(jwt, request, query);
    if (!job) throw new Error('smoke job create failed');
    const id = text(job.id);
    job = await patchJob(jwt, id, {
      status: 'running', progress: 5, stage: 'Preview E2E smoke testを開始しています', started_at: new Date().toISOString()
    }) || job;
    const run = await start(neonReportWorkflow, [id]);
    return Response.json({ started: true, job, workflow_run_id: run.runId }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'smoke test failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

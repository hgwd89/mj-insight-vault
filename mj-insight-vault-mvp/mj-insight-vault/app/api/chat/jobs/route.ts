import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { createJob, latestActiveJob } from '@/lib/neonReportStore';
import { requireNeonJwt } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_QUERY_CHARS = 12_000;
const PIPELINE_VERSION = 'neon_report_pipeline_v1';

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

    const request = { ...raw, query, pipeline_version: PIPELINE_VERSION, source_store: 'neon' };
    const job = await createJob(jwt, request, query);
    if (!job) throw new Error('レポートジョブを作成できませんでした。');
    return Response.json({ job });
  } catch (error) {
    return jsonError(error);
  }
}

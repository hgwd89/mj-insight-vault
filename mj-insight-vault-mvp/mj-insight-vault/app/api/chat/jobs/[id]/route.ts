import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getJob, patchJob } from '@/lib/neonReportStore';
import { requireNeonJwt } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 60;
const STALE_RUNNING_MS = 6 * 60 * 1000;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const { id } = await params;
    if (!id) return Response.json({ error: 'job id is required' }, { status: 400 });
    let job = await getJob(jwt, String(id));
    if (!job) return Response.json({ error: 'job not found' }, { status: 404 });

    if (job.status === 'running') {
      const heartbeat = text(job.heartbeat_at);
      const parsed = heartbeat ? Date.parse(heartbeat) : 0;
      if (!parsed || Date.now() - parsed > STALE_RUNNING_MS) {
        job = await patchJob(jwt, String(id), {
          status: 'queued',
          stage: '前回処理が中断されたため再開待ちです',
          progress: Math.max(5, Math.min(96, Number(job.progress || 5))),
          next_retry_at: null
        }) || job;
      }
    }

    const retryAt = text(job.next_retry_at);
    const retryInSeconds = retryAt ? Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)) : 0;
    return Response.json({ job, retry_in_seconds: retryInSeconds });
  } catch (error) {
    return jsonError(error);
  }
}

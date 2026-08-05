import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

const LEGACY_STALE_RUNNING_MS = 6 * 60 * 1000;

function valueText(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function hasSavedReport(job: Record<string, unknown>) {
  return Boolean(job.report_id);
}

function isStaleRunning(job: Record<string, unknown>) {
  if (job.status !== 'running') return false;
  const leaseExpiry = valueText(job.lease_expires_at);
  if (leaseExpiry) {
    const parsed = Date.parse(leaseExpiry);
    return !Number.isNaN(parsed) && parsed <= Date.now();
  }
  const heartbeat = valueText(job.heartbeat_at);
  const parsed = heartbeat ? Date.parse(heartbeat) : 0;
  if (!parsed || Number.isNaN(parsed)) return true;
  return Date.now() - parsed > LEGACY_STALE_RUNNING_MS;
}

async function markCompleted(id: string, job: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.from('chat_jobs').update({
    status: 'completed',
    progress: 100,
    stage: 'レポート生成完了',
    error_message: null,
    finished_at: job.finished_at || new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    lease_token: null,
    lease_expires_at: null,
    next_retry_at: null,
    updated_at: new Date().toISOString()
  }).eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

async function recoverStaleJob(id: string, job: Record<string, unknown>) {
  let query = supabaseAdmin.from('chat_jobs').update({
    status: 'queued',
    stage: '前回処理のリースが切れたため再開待ちです',
    progress: Math.max(5, Math.min(96, Number(job.progress || 5))),
    heartbeat_at: new Date().toISOString(),
    lease_token: null,
    lease_expires_at: null,
    next_retry_at: null,
    updated_at: new Date().toISOString()
  }).eq('id', id).eq('status', 'running');

  const currentLease = valueText(job.lease_token);
  const currentHeartbeat = valueText(job.heartbeat_at);
  if (currentLease) query = query.eq('lease_token', currentLease);
  else if (currentHeartbeat) query = query.eq('heartbeat_at', currentHeartbeat);

  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw error;
  return data;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id?: string }> }) {
  try {
    requireAppPassword(req);
    const { id } = await params;
    if (!id) return Response.json({ error: 'job id is required' }, { status: 400 });

    const loaded = await supabaseAdmin.from('chat_jobs').select('*').eq('id', String(id)).single();
    if (loaded.error) throw loaded.error;
    const data = loaded.data;

    if (data && data.status !== 'completed' && hasSavedReport(data)) {
      const completed = await markCompleted(String(id), data);
      return Response.json({ job: completed, completed_recovered: true });
    }

    if (data && isStaleRunning(data)) {
      const queued = await recoverStaleJob(String(id), data);
      if (queued) return Response.json({ job: queued, stale_recovered: true });
      const current = await supabaseAdmin.from('chat_jobs').select('*').eq('id', String(id)).single();
      if (current.error) throw current.error;
      return Response.json({ job: current.data, stale_recovery_raced: true });
    }

    const retryAt = valueText(data?.next_retry_at);
    const retryInSeconds = retryAt ? Math.max(0, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)) : 0;
    return Response.json({ job: data, retry_in_seconds: retryInSeconds });
  } catch (error) {
    return jsonError(error);
  }
}

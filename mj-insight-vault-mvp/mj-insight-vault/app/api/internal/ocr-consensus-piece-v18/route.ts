import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getOcrConsensusPieceV18Status, runOcrConsensusPieceV18Step } from '@/lib/ocrConsensusPieceWorkerV18';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

type RuntimeRow = {
  cohort_id: string;
  job_id_1: string;
  job_id_2: string;
  active: boolean;
  activated_at: string;
};

async function getNanoCanaryRuntime() {
  const { data: runtime, error: runtimeError } = await supabaseAdmin
    .from('ocr_consensus_canary_runtime_v32')
    .select('cohort_id,job_id_1,job_id_2,active,activated_at')
    .eq('singleton', true)
    .maybeSingle<RuntimeRow>();
  if (runtimeError) throw runtimeError;

  if (!runtime?.active) {
    return {
      runnable: false as const,
      status: 'paused_no_active_canary_cohort',
      full_rollout_execution: false
    };
  }

  const allowed = new Set([String(runtime.job_id_1), String(runtime.job_id_2)]);
  if (allowed.size !== 2) throw new Error('OCR v32 runtime binding is not exactly two jobs.');

  const { data: activeJobs, error: jobsError } = await supabaseAdmin
    .from('ocr_consensus_jobs_v11')
    .select('id,status,is_canary')
    .eq('is_canary', true)
    .in('status', ['queued', 'running']);
  if (jobsError) throw jobsError;

  const unscoped = (activeJobs || []).filter((job) => !allowed.has(String(job.id)));
  if (unscoped.length > 0) {
    throw new Error(`OCR v32 blocked ${unscoped.length} active canary job(s) outside the bound cohort.`);
  }

  return {
    runnable: true as const,
    status: 'nano_canary_only',
    cohort_id: runtime.cohort_id,
    job_ids: [...allowed],
    active_jobs: activeJobs || [],
    full_rollout_execution: false
  };
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const runtime = await getNanoCanaryRuntime();
    return Response.json({
      ok: true,
      ...runtime,
      historical_canary_execution: runtime.runnable,
      worker_status: await getOcrConsensusPieceV18Status()
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const runtime = await getNanoCanaryRuntime();
    if (!runtime.runnable) {
      return Response.json({
        ok: true,
        ...runtime,
        historical_canary_execution: false
      });
    }

    // Exactly one worker step per request. The DB-side v32 claim is additionally
    // scoped to the two jobs in the activated cohort, so this endpoint cannot
    // claim a non-canary or an unrelated historical canary even under a race.
    const result = await runOcrConsensusPieceV18Step();
    return Response.json({
      ok: true,
      ...runtime,
      historical_canary_execution: true,
      result,
      worker_status: await getOcrConsensusPieceV18Status()
    });
  } catch (error) {
    return jsonError(error);
  }
}

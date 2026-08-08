import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runVerifiedDuplicateAuditWorkerStep } from '@/lib/verifiedDuplicateAuditWorker';

export const runtime = 'nodejs';
export const maxDuration = 180;

async function getStatus() {
  const [{ data: gate, error: gateError }, { data: run, error: runError }] = await Promise.all([
    supabaseAdmin.from('source_grounded_duplicate_gate_v6').select('*').maybeSingle(),
    supabaseAdmin
      .from('source_grounded_duplicate_audit_runs_v5')
      .select('*')
      .eq('detection_version', 'verified_ocr_duplicate_audit_v6')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);
  if (gateError) throw gateError;
  if (runError) throw runError;
  let reviewJobs: Record<string, number> = {};
  if (run?.id) {
    const { data, error } = await supabaseAdmin.from('source_grounded_duplicate_review_jobs_v7').select('status').eq('run_id', run.id);
    if (error) throw error;
    reviewJobs = (data || []).reduce<Record<string, number>>((acc, row) => {
      const status = String(row.status || 'unknown');
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
  }
  return { gate, run, review_jobs: reviewJobs };
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await getStatus());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    const step = await runVerifiedDuplicateAuditWorkerStep();
    return Response.json({ step, ...(await getStatus()) });
  } catch (error) {
    return jsonError(error);
  }
}

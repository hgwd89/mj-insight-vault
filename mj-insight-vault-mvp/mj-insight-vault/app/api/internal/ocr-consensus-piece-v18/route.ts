import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { ARTICLE_BLOCK_READING_VERSION_V21 } from '@/lib/articleBlockReadingV21';
import { getOcrConsensusPieceV18Status, runOcrConsensusPieceV18Step } from '@/lib/ocrConsensusPieceWorkerV18';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

async function assertNoLegacyCanaryPieceReceipts() {
  const { data: jobs, error: jobsError } = await supabaseAdmin
    .from('ocr_consensus_jobs_v11')
    .select('id')
    .eq('is_canary', true);
  if (jobsError) throw jobsError;

  const jobIds = (jobs || []).map((row) => String(row.id || '').trim()).filter(Boolean);
  if (!jobIds.length) return;

  const { data: receipts, error: receiptsError } = await supabaseAdmin
    .from('ocr_independent_segment_receipts_v16')
    .select('job_id,segmentation_version')
    .in('job_id', jobIds);
  if (receiptsError) throw receiptsError;

  const incompatible = (receipts || []).filter(
    (row) => String(row.segmentation_version || '').trim() !== ARTICLE_BLOCK_READING_VERSION_V21
  );
  if (!incompatible.length) return;

  const versions = [...new Set(incompatible.map((row) => String(row.segmentation_version || '').trim() || 'missing'))].sort();
  const affectedJobs = [...new Set(incompatible.map((row) => String(row.job_id || '').trim()).filter(Boolean))].sort();
  throw new Error(
    `OCR consensus v21 preflight blocked legacy piece receipts: versions=${versions.join(',')} jobs=${affectedJobs.join(',')}. Archive/requeue the canaries before resuming.`
  );
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, status: await getOcrConsensusPieceV18Status() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    await assertNoLegacyCanaryPieceReceipts();

    // Keep one request below the Vercel function ceiling. Two independent piece
    // workers still run in parallel, but a second sequential round can push a
    // healthy provider call past the 180s route limit and discard completed work.
    const rounds = [await Promise.all([
      runOcrConsensusPieceV18Step(),
      runOcrConsensusPieceV18Step()
    ])];

    return Response.json({ ok: true, rounds, status: await getOcrConsensusPieceV18Status() });
  } catch (error) {
    return jsonError(error);
  }
}

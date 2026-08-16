import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { runOcrVerificationWorkerStep } from '@/lib/ocrVerificationWorker';
import { runVerifiedArticleEmbeddingWorkerStep } from '@/lib/verifiedArticleEmbeddingWorker';
import { runVerifiedDuplicateAuditWorkerStep } from '@/lib/verifiedDuplicateAuditWorker';
import { runVerifiedArticleClassificationWorkerStep } from '@/lib/verifiedArticleClassificationWorker';
import { runVerifiedArticleReviewWorkerStep } from '@/lib/verifiedArticleReviewWorker';
import { runVerifiedThemeCandidateWorkerStep } from '@/lib/verifiedThemeCandidateWorker';
import { runVerifiedThemeCensusWorkerStep } from '@/lib/verifiedThemeCensusWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const SCHEDULER_LEASE_SECONDS = 210;
type StepRecord = Record<string, unknown>;

function record(value: unknown): StepRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StepRecord : {};
}

function stepStage(value: unknown) {
  return String(record(value).stage || 'unknown');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'verified pipeline scheduler error');
}

async function currentSchedulerState() {
  const [{ data: state, error: stateError }, { data: safety, error: safetyError }] = await Promise.all([
    supabaseAdmin.from('verified_pipeline_scheduler_state_v1').select('*').eq('singleton', true).maybeSingle(),
    supabaseAdmin.from('strict_system_safety_audit_v24').select('system_safety_gate').maybeSingle()
  ]);
  if (stateError) throw stateError;
  if (safetyError) throw safetyError;
  return { state, system_safety_gate: safety?.system_safety_gate || null };
}

async function claimSchedulerRun() {
  const { data, error } = await supabaseAdmin.rpc('claim_verified_pipeline_scheduler_run_v1', {
    p_lease_seconds: SCHEDULER_LEASE_SECONDS
  });
  if (error) throw error;
  return record(data);
}

async function finishSchedulerRun(
  leaseToken: string,
  status: 'ok' | 'error' | 'skipped',
  stage: string,
  summary: StepRecord,
  errorValue?: string
) {
  const { error } = await supabaseAdmin.rpc('finish_verified_pipeline_scheduler_run_v1', {
    p_lease_token: leaseToken,
    p_status: status,
    p_stage: stage,
    p_summary: summary,
    p_error: errorValue || null
  });
  if (error) throw error;
}

async function ensureVerifiedOcrCorpusReceipt() {
  const [{ data: gate, error: gateError }, { data: receipt, error: receiptError }] = await Promise.all([
    supabaseAdmin.from('ocr_verification_gate_v2').select('ocr_verification_gate').maybeSingle(),
    supabaseAdmin.from('current_verified_ocr_corpus_receipt_v5').select('id').maybeSingle()
  ]);
  if (gateError) throw gateError;
  if (receiptError) throw receiptError;
  if (gate?.ocr_verification_gate !== 'passed') return { ready: false as const, receipt_id: null };
  if (receipt?.id) return { ready: true as const, receipt_id: String(receipt.id), created: false as const };
  const { data, error } = await supabaseAdmin.rpc('create_verified_ocr_corpus_receipt_v5');
  if (error) throw error;
  return { ready: true as const, receipt_id: String(data || ''), created: true as const };
}

async function runStrictPipelineTick() {
  const trace: Array<{ stage: string; result: unknown }> = [];

  const ocr = await runOcrVerificationWorkerStep();
  trace.push({ stage: 'ocr_verification', result: ocr });
  const ocrStage = stepStage(ocr);
  if (ocrStage === 'blocked') return { stage: 'blocked', blocked_at: 'ocr_verification', trace };
  if (ocrStage !== 'idle') return { stage: 'ocr_verification', trace };

  const ocrReceipt = await ensureVerifiedOcrCorpusReceipt();
  if (!ocrReceipt.ready) return { stage: 'ocr_verification_waiting', trace };
  if (ocrReceipt.created) return { stage: 'ocr_corpus_sealed', receipt: ocrReceipt, trace };

  const embedding = await runVerifiedArticleEmbeddingWorkerStep();
  trace.push({ stage: 'embedding', result: embedding });
  const embeddingStage = stepStage(embedding);
  if (embeddingStage === 'blocked') return { stage: 'blocked', blocked_at: 'embedding', trace };
  if (embeddingStage !== 'idle') return { stage: 'embedding', trace };

  const duplicate = await runVerifiedDuplicateAuditWorkerStep();
  trace.push({ stage: 'duplicate_audit', result: duplicate });
  const duplicateStage = stepStage(duplicate);
  if (duplicateStage === 'blocked') return { stage: 'blocked', blocked_at: 'duplicate_audit', trace };
  if (duplicateStage !== 'idle') return { stage: 'duplicate_audit', trace };

  const classification = await runVerifiedArticleClassificationWorkerStep();
  trace.push({ stage: 'classification', result: classification });
  const classificationStage = stepStage(classification);
  if (classificationStage === 'blocked') return { stage: 'blocked', blocked_at: 'classification', trace };
  if (classificationStage !== 'idle') return { stage: 'classification', trace };

  const review = await runVerifiedArticleReviewWorkerStep();
  trace.push({ stage: 'article_review', result: review });
  const reviewStage = stepStage(review);
  if (reviewStage === 'blocked') return { stage: 'blocked', blocked_at: 'article_review', trace };
  if (reviewStage !== 'idle') return { stage: 'article_review', trace };

  const candidates = await runVerifiedThemeCandidateWorkerStep();
  trace.push({ stage: 'theme_candidates', result: candidates });
  const candidateStage = stepStage(candidates);
  if (candidateStage === 'blocked') return { stage: 'blocked', blocked_at: 'theme_candidates', trace };
  if (candidateStage !== 'idle') return { stage: 'theme_candidates', trace };

  const census = await runVerifiedThemeCensusWorkerStep();
  trace.push({ stage: 'theme_census', result: census });
  const censusStage = stepStage(census);
  if (censusStage === 'blocked') return { stage: 'blocked', blocked_at: 'theme_census', trace };
  if (censusStage !== 'idle') return { stage: 'theme_census', trace };

  return { stage: 'verified_pipeline_ready_for_report_v15', trace };
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));

    const claim = await claimSchedulerRun();
    if (!claim.claimed) {
      return Response.json({ ok: true, skipped: true, claim, scheduler: await currentSchedulerState() }, { status: 202 });
    }

    const leaseToken = String(claim.lease_token || '');
    if (!/^[0-9a-f-]{36}$/i.test(leaseToken)) throw new Error('Verified pipeline scheduler lease token is invalid.');

    try {
      const result = await runStrictPipelineTick();
      const stage = stepStage(result);
      const summary = { claim, result };
      await finishSchedulerRun(leaseToken, 'ok', stage, summary);
      return Response.json({ ok: true, claim, result, scheduler: await currentSchedulerState() });
    } catch (error) {
      const message = errorMessage(error);
      await finishSchedulerRun(leaseToken, 'error', 'runtime_error', { claim }, message).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, scheduler: await currentSchedulerState() });
  } catch (error) {
    return jsonError(error);
  }
}

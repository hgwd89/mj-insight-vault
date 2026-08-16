import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { runArticleInventoryWorkerV7GroundedOrchestratorStep } from '@/lib/articleInventoryWorkerV7GroundedOrchestrator';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const RECOVERED_VERSION = 'page_article_inventory_v4_recovered_ocr';
const LANES = 2;
const SCHEDULER_LEASE_SECONDS = 210;

// Formal Inventory V7 contract requires a third model distinct from mapper/critic.
// Pin it here so scheduler execution cannot silently fall back to the historical mini default.
process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL = 'gpt-5.6-sol';

type JsonRecord = Record<string, unknown>;

type LaneResult = {
  lane: number;
  ok: boolean;
  step?: unknown;
  error?: string;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'inventory v7 lane error');
}

function hasProviderQuotaExhaustion(value: unknown) {
  const normalized = JSON.stringify(value || {}).toLowerCase();
  return normalized.includes('credit_balance_exhausted')
    || normalized.includes('no credits remaining')
    || normalized.includes('insufficient_quota');
}

async function currentState() {
  const { data: control, error: controlError } = await supabaseAdmin
    .from('inventory_v3_execution_control_v1')
    .select('freeze_receipt_id,enabled,grounded_third_pass_enabled,reason')
    .eq('singleton', true)
    .single();
  if (controlError) throw controlError;

  const freeze = String(control?.freeze_receipt_id || '');
  if (!freeze) {
    return { freeze_receipt_id: null, counts: {}, exceptions: 0, control };
  }

  const { data: jobs, error: jobsError } = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('status,requires_third_pass')
    .eq('freeze_receipt_id', freeze)
    .eq('inventory_version', RECOVERED_VERSION);
  if (jobsError) throw jobsError;

  const counts: Record<string, number> = {};
  let exceptions = 0;
  for (const row of jobs || []) {
    const status = String(row.status || 'unknown');
    const key = `${status}:${row.requires_third_pass ? 'third' : 'normal'}`;
    counts[key] = (counts[key] || 0) + 1;
    if (status === 'needs_review' || status === 'discovery_required' || status === 'failed') exceptions += 1;
  }
  return { freeze_receipt_id: freeze, counts, exceptions, control };
}

async function maybeEnableThirdPass() {
  const state = await currentState();
  if (!state.freeze_receipt_id || state.control?.grounded_third_pass_enabled) {
    return { attempted: false, reason: 'already_enabled_or_no_freeze' };
  }
  const normalQueued = Number(state.counts['queued:normal'] || 0);
  const normalRunning = Number(state.counts['running:normal'] || 0);
  const thirdQueued = Number(state.counts['queued:third'] || 0);
  if (normalQueued > 0 || normalRunning > 0 || thirdQueued < 1) {
    return { attempted: false, reason: 'first_two_pass_work_remaining_or_no_third_pass_jobs', normalQueued, normalRunning, thirdQueued };
  }
  const { data, error } = await supabaseAdmin.rpc('enable_grounded_inventory_v7_third_pass_v1');
  if (error) {
    // Fail closed for the gate itself, but do not crash the scheduler. The next tick can retry.
    return { attempted: true, enabled: false, error: error.message };
  }
  return { attempted: true, enabled: true, result: data };
}

async function claimSchedulerRun() {
  const { data, error } = await supabaseAdmin.rpc('claim_inventory_v7_scheduler_run_v1', {
    p_lease_seconds: SCHEDULER_LEASE_SECONDS
  });
  if (error) throw error;
  return asRecord(data);
}

async function finishSchedulerRun(
  leaseToken: string,
  status: 'ok' | 'error' | 'skipped',
  claimedSteps: number,
  exceptionSteps: number,
  summary: JsonRecord,
  errorMessageValue?: string
) {
  const { error } = await supabaseAdmin.rpc('finish_inventory_v7_scheduler_run_v1', {
    p_lease_token: leaseToken,
    p_status: status,
    p_claimed_steps: claimedSteps,
    p_exception_steps: exceptionSteps,
    p_summary: summary,
    p_error: errorMessageValue || null
  });
  if (error) throw error;
}

async function tripProviderQuotaCircuitBreaker() {
  const { data, error } = await supabaseAdmin.rpc('set_inventory_v7_scheduler_enabled_v1', {
    p_enabled: false,
    p_reason: 'provider_quota_exhausted_circuit_breaker'
  });
  if (error) throw error;
  return data;
}

function stepHasException(step: unknown) {
  const text = JSON.stringify(step || {});
  return text.includes('needs_review') || text.includes('discovery_required') || text.includes('"status":"failed"');
}

async function runLane(lane: number): Promise<LaneResult> {
  try {
    const step = await runArticleInventoryWorkerV7GroundedOrchestratorStep();
    return { lane, ok: true, step };
  } catch (error) {
    // A single DB/provider/job failure must never abort the other lane or the recurring scheduler.
    // The underlying job lease/fail-closed state remains authoritative and a later tick can continue.
    return { lane, ok: false, error: errorMessage(error) };
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const claim = await claimSchedulerRun();
    if (!claim.claimed) {
      return Response.json({ ok: true, skipped: true, claim, state: await currentState() }, { status: 202 });
    }

    const leaseToken = String(claim.lease_token || '');
    if (!/^[0-9a-f-]{36}$/i.test(leaseToken)) throw new Error('Scheduler lease token is invalid.');

    let claimedSteps = 0;
    let exceptionSteps = 0;
    const steps: unknown[] = [];

    try {
      const results = await Promise.all(Array.from({ length: LANES }, (_, index) => runLane(index + 1)));

      for (const result of results) {
        if (!result.ok) {
          exceptionSteps += 1;
          steps.push(result);
          continue;
        }
        const claimed = Number(asRecord(result.step).claimed || 0);
        claimedSteps += claimed;
        if (claimed > 0 && stepHasException(result.step)) exceptionSteps += 1;
        steps.push(result);
      }

      if (results.some(hasProviderQuotaExhaustion)) {
        const stateBeforePause = await currentState();
        const summary = {
          steps,
          third_pass_gate: { attempted: false, reason: 'provider_quota_exhausted_circuit_breaker' },
          provider_quota_exhausted: true,
          state: stateBeforePause
        };
        // Close the audit row while the lease is still valid. Disabling the scheduler clears the lease.
        await finishSchedulerRun(leaseToken, 'ok', claimedSteps, exceptionSteps, summary);
        const circuitBreaker = await tripProviderQuotaCircuitBreaker();
        const state = await currentState();
        return Response.json({ ok: true, paused: true, claimed_steps: claimedSteps, exception_steps: exceptionSteps, ...summary, provider_circuit_breaker: circuitBreaker, state });
      }

      const thirdPass = await maybeEnableThirdPass();
      const state = await currentState();
      const summary = { steps, third_pass_gate: thirdPass, state };
      await finishSchedulerRun(leaseToken, 'ok', claimedSteps, exceptionSteps, summary);
      return Response.json({ ok: true, claimed_steps: claimedSteps, exception_steps: exceptionSteps, ...summary });
    } catch (error) {
      const message = errorMessage(error);
      const state = await currentState().catch(() => null);
      await finishSchedulerRun(leaseToken, 'error', claimedSteps, exceptionSteps, { steps, state }, message).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json({ ok: true, scheduler: await currentState() });
  } catch (error) {
    return jsonError(error);
  }
}

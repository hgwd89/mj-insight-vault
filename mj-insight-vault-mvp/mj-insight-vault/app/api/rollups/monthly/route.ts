import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import {
  listArticleMonthCounts,
  listArticleMonths,
  listMonthlyRollups
} from '@/lib/monthlyRollups';
import { enqueueMonthlyRollup, kickMonthlyRollupWorker } from '@/lib/monthlyRollupWorker';

export const runtime = 'nodejs';
export const maxDuration = 60;

type JsonRecord = Record<string, unknown>;

type RollupRow = {
  month_key: string;
  article_count: number;
  status: string;
  rollup_model: string;
  summary_json: JsonRecord | null;
  lease_expires_at?: string | null;
  next_retry_at?: string | null;
  updated_at: string;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function limit(value: unknown) {
  const n = Number(value || 3);
  return Math.max(1, Math.min(3, Number.isFinite(n) ? n : 3));
}

function validMonthKey(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value === 'undated';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function bool(value: unknown) {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes'].includes(text(value).toLowerCase());
}

function activeLease(row: RollupRow) {
  if (row.status !== 'running') return false;
  const expires = Date.parse(text(row.lease_expires_at));
  return Number.isFinite(expires) && expires > Date.now();
}

function validatedReady(row: RollupRow | undefined, expectedCount: number) {
  if (!row || row.status !== 'ready' || row.article_count !== expectedCount) return false;
  const json = isRecord(row.summary_json) ? row.summary_json : {};
  const method = text(json.generation_method);
  const sourceIds = Array.isArray(json.source_article_ids) ? json.source_article_ids : [];
  return bool(json.rollup_analysis_is_validated)
    && !bool(json.fallback_used)
    && ['hierarchical_llm_worker', 'hierarchical_llm', 'empty'].includes(method)
    && (expectedCount === 0 || sourceIds.length === expectedCount);
}

async function rawStatus() {
  const [months, monthCounts, rawRollups] = await Promise.all([
    listArticleMonths(),
    listArticleMonthCounts(),
    listMonthlyRollups()
  ]);
  const rollups = rawRollups as unknown as RollupRow[];
  const byMonth = new Map(rollups.map((row) => [row.month_key, row]));
  const neededMonths: string[] = [];
  const pendingMonths: string[] = [];
  const staleMonths: string[] = [];
  const invalidReadyMonths: string[] = [];

  for (const month of months) {
    const row = byMonth.get(month);
    const expectedCount = Number(monthCounts[month] || 0);
    if (validatedReady(row, expectedCount)) continue;
    if (row?.status === 'stale') staleMonths.push(month);
    if (row?.status === 'queued' || activeLease(row as RollupRow)) {
      pendingMonths.push(month);
      continue;
    }
    if (row?.status === 'ready') invalidReadyMonths.push(month);
    neededMonths.push(month);
  }

  return {
    months,
    month_counts: monthCounts,
    rollups,
    stale_months: staleMonths,
    needed_months: neededMonths,
    pending_months: pendingMonths,
    invalid_ready_months: invalidReadyMonths
  };
}

async function statusPayload(extra: JsonRecord = {}) {
  return { ...(await rawStatus()), ...extra };
}

async function enqueueMonths(months: string[], force: boolean) {
  const queued = [];
  for (const month of months) queued.push(await enqueueMonthlyRollup(month, force));
  let workerKick: unknown = null;
  let workerKickError = '';
  if (queued.length) {
    try {
      workerKick = await kickMonthlyRollupWorker();
    } catch (error) {
      workerKickError = error instanceof Error ? error.message : 'monthly rollup worker kick failed';
    }
  }
  return { queued, workerKick, workerKickError };
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await statusPayload());
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const monthKey = text(body.month_key);
    const all = Boolean(body.all);
    const staleOnly = Boolean(body.stale_only);
    const needsOnly = Boolean(body.needs_only);
    const maxMonths = limit(body.limit);
    const before = await rawStatus();

    let attemptedMonths: string[] = [];
    let force = Boolean(body.force);
    let mode = 'single';

    if (needsOnly) {
      attemptedMonths = before.needed_months.slice(0, maxMonths);
      force = true;
      mode = 'needs_only_queued';
    } else if (staleOnly) {
      attemptedMonths = before.stale_months.slice(0, maxMonths);
      mode = 'stale_only_queued';
    } else if (all) {
      attemptedMonths = before.months;
      force = true;
      mode = 'all_queued';
    } else {
      if (!validMonthKey(monthKey)) {
        return Response.json({ error: 'month_key must be YYYY-MM or undated' }, { status: 400 });
      }
      attemptedMonths = [monthKey];
      force = body.force !== false;
    }

    const result = await enqueueMonths(attemptedMonths, force);
    return Response.json(await statusPayload({
      rollups_generated: result.queued,
      queued_count: result.queued.length,
      generated_count: 0,
      attempted_months: attemptedMonths,
      worker_kick_request_id: result.workerKick,
      worker_kick_error: result.workerKickError || null,
      remaining_before: Math.max(0, before.needed_months.length - result.queued.length),
      mode
    }), { status: result.queued.length ? 202 : 200 });
  } catch (error) {
    return jsonError(error);
  }
}

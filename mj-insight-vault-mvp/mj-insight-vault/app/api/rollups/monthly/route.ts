import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import {
  generateMonthlyRollup,
  generateNeededMonthlyRollups,
  generateStaleMonthlyRollups,
  listArticleMonthCounts,
  listArticleMonths,
  listMonthlyRollups,
  listNeededRollupMonths,
  listStaleRollupMonths
} from '@/lib/monthlyRollups';

export const runtime = 'nodejs';
export const maxDuration = 300;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function limit(value: unknown) {
  const n = Number(value || 1);
  return Math.max(1, Math.min(3, Number.isFinite(n) ? n : 1));
}

async function statusPayload(extra: Record<string, unknown> = {}) {
  const [months, month_counts, rollups, stale_months, needed_months] = await Promise.all([
    listArticleMonths(),
    listArticleMonthCounts(),
    listMonthlyRollups(),
    listStaleRollupMonths(),
    listNeededRollupMonths()
  ]);
  return { months, month_counts, rollups, stale_months, needed_months, ...extra };
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

    if (needsOnly) {
      const before = await listNeededRollupMonths();
      const rollups = await generateNeededMonthlyRollups(maxMonths);
      return Response.json(await statusPayload({
        rollups_generated: rollups,
        generated_count: rollups.length,
        attempted_months: before.slice(0, maxMonths),
        remaining_before: Math.max(0, before.length - rollups.length),
        mode: 'needs_only'
      }));
    }

    if (staleOnly) {
      const before = await listStaleRollupMonths();
      const rollups = await generateStaleMonthlyRollups(maxMonths);
      return Response.json(await statusPayload({
        rollups_generated: rollups,
        generated_count: rollups.length,
        attempted_months: before.slice(0, maxMonths),
        remaining_before: Math.max(0, before.length - rollups.length),
        mode: 'stale_only'
      }));
    }

    if (all) {
      const months = (await listArticleMonths()).slice(0, maxMonths);
      const results = [];
      for (const month of months) {
        results.push(await generateMonthlyRollup(month));
      }
      return Response.json(await statusPayload({
        rollups_generated: results,
        generated_count: results.length,
        attempted_months: months,
        mode: 'all_bounded'
      }));
    }

    if (!/^\d{4}-\d{2}$/.test(monthKey)) {
      return Response.json({ error: 'month_key must be YYYY-MM' }, { status: 400 });
    }

    const rollup = await generateMonthlyRollup(monthKey);
    return Response.json(await statusPayload({ rollup, rollups_generated: [rollup], generated_count: 1, mode: 'single' }));
  } catch (error) {
    return jsonError(error);
  }
}

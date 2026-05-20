import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import {
  generateMonthlyRollup,
  generateStaleMonthlyRollups,
  listArticleMonths,
  listMonthlyRollups,
  listStaleRollupMonths
} from '@/lib/monthlyRollups';

export const runtime = 'nodejs';
export const maxDuration = 300;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const [months, rollups, stale_months] = await Promise.all([
      listArticleMonths(),
      listMonthlyRollups(),
      listStaleRollupMonths()
    ]);
    return Response.json({ months, rollups, stale_months });
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

    if (staleOnly) {
      const rollups = await generateStaleMonthlyRollups();
      return Response.json({ rollups, mode: 'stale_only' });
    }

    if (all) {
      const months = await listArticleMonths();
      const results = [];
      for (const month of months) {
        results.push(await generateMonthlyRollup(month));
      }
      return Response.json({ rollups: results, mode: 'all' });
    }

    if (!/^\d{4}-\d{2}$/.test(monthKey)) {
      return Response.json({ error: 'month_key must be YYYY-MM' }, { status: 400 });
    }

    const rollup = await generateMonthlyRollup(monthKey);
    return Response.json({ rollup, mode: 'single' });
  } catch (error) {
    return jsonError(error);
  }
}

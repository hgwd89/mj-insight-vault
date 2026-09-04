import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { requireNeonJwt } from '@/lib/neonCloud';
import { listReports } from '@/lib/neonReportStore';

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const report = (await listReports(jwt, 1, 0))[0];
    if (!report) return Response.json({ report: null, source: 'neon' });
    return Response.json({
      report: {
        id: text(report.id),
        created_at: text(report.created_at),
        user_query: text(report.user_query),
        answer_head: text(report.answer_text).slice(0, 240)
      },
      source: 'neon'
    });
  } catch (error) {
    return jsonError(error);
  }
}

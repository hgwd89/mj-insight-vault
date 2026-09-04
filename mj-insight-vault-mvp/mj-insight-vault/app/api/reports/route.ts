import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { requireNeonJwt } from '@/lib/neonCloud';
import { listReports } from '@/lib/neonReportStore';

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const reports = await listReports(jwt, limit, offset);
    return Response.json({ reports, meta: { limit, offset, returned: reports.length, source: 'neon' } });
  } catch (error) {
    return jsonError(error);
  }
}

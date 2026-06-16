import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { diagnoseLatestReport } from '@/lib/latestReportDiagnostics';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await diagnoseLatestReport());
  } catch (error) {
    return jsonError(error);
  }
}

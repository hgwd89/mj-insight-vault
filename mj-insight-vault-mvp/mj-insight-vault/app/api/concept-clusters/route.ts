import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { getConceptClusters } from '@/lib/conceptClusters';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const clusters = await getConceptClusters();
    return Response.json({ clusters, count: clusters.length });
  } catch (error) {
    return jsonError(error);
  }
}

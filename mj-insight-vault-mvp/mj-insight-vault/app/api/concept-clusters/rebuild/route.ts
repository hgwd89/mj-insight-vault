import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { rebuildConceptClusters, CONCEPT_CLUSTERS_K_DEFAULT } from '@/lib/conceptClusters';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;

    // k: query param > body > env > default
    const kFromQuery = req.nextUrl.searchParams.get('k');
    const kFromBody = body.k;
    const kFromEnv = process.env.CONCEPT_CLUSTERS_K;
    const k = Math.max(2, Math.min(50,
      Number(kFromQuery ?? kFromBody ?? kFromEnv ?? CONCEPT_CLUSTERS_K_DEFAULT)
    ));

    const result = await rebuildConceptClusters(k);
    return Response.json({ status: 'ok', ...result });
  } catch (error) {
    return jsonError(error);
  }
}

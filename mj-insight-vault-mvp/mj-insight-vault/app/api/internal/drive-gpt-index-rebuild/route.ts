import { getOwnerNeonJwt } from '@/lib/cloudStockBackgroundOcr';
import { rebuildDriveGptArticleIndex } from '@/lib/driveGptArticleIndex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET() {
  if (process.env.VERCEL_ENV !== 'preview') {
    return Response.json({ ok: false, error: 'preview only' }, { status: 404 });
  }

  try {
    const jwt = await getOwnerNeonJwt();
    const result = await rebuildDriveGptArticleIndex(jwt);
    return Response.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}

import { NextRequest } from 'next/server';
import { getOwnerNeonJwt } from '@/lib/cloudStockBackgroundOcr';
import { rebuildDriveGptArticleIndex } from '@/lib/driveGptArticleIndex';
import { inspectGoogleDriveFolder } from '@/lib/googleDriveBackup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (process.env.VERCEL_ENV !== 'preview') {
    return Response.json({ ok: false, error: 'preview only' }, { status: 404 });
  }

  try {
    if (req.nextUrl.searchParams.get('probe') === '1') {
      const probe = await inspectGoogleDriveFolder('1FZNZaPO9MTC147yNzinSY_bGvyFTUfnG');
      return Response.json({ ok: true, probe }, { headers: { 'cache-control': 'no-store' } });
    }

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

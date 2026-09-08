import { getOwnerNeonJwt, organizeOneSource, pendingOrganizeSourceIds } from '@/lib/cloudStockBackgroundOcr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function GET() {
  if (process.env.VERCEL_ENV !== 'preview') {
    return Response.json({ ok: false, error: 'preview only' }, { status: 404 });
  }

  const jwt = await getOwnerNeonJwt();
  const pending = await pendingOrganizeSourceIds(jwt);
  const targets = pending.slice(0, 10);
  const results: Array<{ source_file_id: string; ok: boolean; article_count?: number; error?: string }> = [];

  for (let index = 0; index < targets.length; index += 2) {
    const batch = targets.slice(index, index + 2);
    const settled = await Promise.allSettled(
      batch.map((sourceFileId) => organizeOneSource(jwt, sourceFileId))
    );
    settled.forEach((result, offset) => {
      const sourceFileId = batch[offset];
      if (result.status === 'fulfilled') {
        const value = result.value as { article_count?: number };
        results.push({ source_file_id: sourceFileId, ok: true, article_count: Number(value.article_count || 0) });
      } else {
        results.push({
          source_file_id: sourceFileId,
          ok: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    });
  }

  const remaining = await pendingOrganizeSourceIds(jwt);
  return Response.json({
    ok: true,
    before: pending.length,
    attempted: targets.length,
    succeeded: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
    after: remaining.length,
    results
  }, { headers: { 'cache-control': 'no-store' } });
}

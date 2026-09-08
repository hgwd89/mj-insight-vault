import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { requireNeonJwt } from '@/lib/neonCloud';
import { organizeNeonSourceArticles } from '@/lib/neonArticleOrganization';
import { pendingOrganizeSourceIds } from '@/lib/cloudStockBackgroundOcr';

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const sourceFileIds = await pendingOrganizeSourceIds(jwt);
    return Response.json({
      ok: true,
      total: sourceFileIds.length,
      rows: sourceFileIds.map((sourceFileId) => ({ source_file_id: sourceFileId }))
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const sourceFileId = clean(body.source_file_id, 100);
    if (!sourceFileId) return Response.json({ error: '資料IDがありません。' }, { status: 400 });

    const result = await organizeNeonSourceArticles({
      jwt,
      sourceFileId,
      force: body.force === true
    });

    return Response.json({ ok: true, ...result });
  } catch (error) {
    return jsonError(error);
  }
}

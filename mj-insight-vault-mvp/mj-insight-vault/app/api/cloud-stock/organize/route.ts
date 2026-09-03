import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';
import { organizeNeonSourceArticles } from '@/lib/neonArticleOrganization';

export const runtime = 'nodejs';
export const maxDuration = 180;

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);

    const sourceResponse = await neonDataFetch(
      'vault_source_files?ocr_status=eq.done&source_status=neq.e2e_test&select=id,file_name,mime_type,ocr_status&order=created_at.asc&limit=5000',
      jwt,
      { method: 'GET' }
    );
    const sourceJson = await parseUpstreamJson(sourceResponse, '記事整理待ち資料を取得できませんでした。');
    const sources = Array.isArray(sourceJson) ? sourceJson as Array<Record<string, unknown>> : [];

    const articleResponse = await neonDataFetch(
      'vault_articles?article_sequence=gt.0&select=source_file_id&limit=5000',
      jwt,
      { method: 'GET' }
    );
    const articleJson = await parseUpstreamJson(articleResponse, '記事整理済み資料を確認できませんでした。');
    const organized = new Set(
      (Array.isArray(articleJson) ? articleJson as Array<Record<string, unknown>> : [])
        .map((row) => clean(row.source_file_id, 100))
        .filter(Boolean)
    );

    const rows = sources
      .filter((source) => !organized.has(clean(source.id, 100)))
      .filter((source) => ['image/jpeg', 'image/png', 'image/webp'].includes(clean(source.mime_type, 200).toLowerCase()))
      .map((source) => ({
        source_file_id: source.id,
        file_name: source.file_name,
        mime_type: source.mime_type,
        ocr_status: source.ocr_status
      }));

    return Response.json({ ok: true, total: rows.length, rows });
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

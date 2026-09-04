import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';

export const runtime = 'nodejs';

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const { id } = await context.params;
    const articleId = clean(id, 100);
    if (!articleId) return Response.json({ error: '記事IDがありません。' }, { status: 400 });

    const articleResponse = await neonDataFetch(
      `vault_articles?id=eq.${encodeURIComponent(articleId)}&article_sequence=gt.0&select=id,source_file_id,article_sequence,title,ocr_text_raw,ocr_text_verified,verification_version,verification_status,confidence,created_at,updated_at&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const articleJson = await parseUpstreamJson(articleResponse, '記事を取得できませんでした。');
    const article = Array.isArray(articleJson) ? articleJson[0] as Record<string, unknown> | undefined : undefined;
    if (!article) return Response.json({ error: '記事が見つかりません。' }, { status: 404 });

    const sourceFileId = clean(article.source_file_id, 100);
    const sourceResponse = await neonDataFetch(
      `vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}&source_status=neq.e2e_test&select=id,drive_file_id,file_name,mime_type,file_size_bytes,article_date,memo,ocr_status,created_at&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const sourceJson = await parseUpstreamJson(sourceResponse, '記事の原本情報を取得できませんでした。');
    const source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;
    if (!source) return Response.json({ error: '記事の原本情報が見つかりません。' }, { status: 404 });

    return Response.json({
      ok: true,
      article: {
        id: article.id,
        source_file_id: article.source_file_id,
        article_sequence: article.article_sequence,
        title: clean(article.title, 1000) || '無題の記事',
        text: clean(article.ocr_text_verified, 100000) || clean(article.ocr_text_raw, 100000),
        verification_version: article.verification_version,
        verification_status: article.verification_status,
        confidence: article.confidence,
        created_at: article.created_at,
        updated_at: article.updated_at,
        article_date: clean(source.article_date, 32) || null,
        source_file_name: clean(source.file_name, 500),
        source_mime_type: clean(source.mime_type, 200) || null,
        source_file_size_bytes: source.file_size_bytes ?? null,
        drive_file_id: clean(source.drive_file_id, 500) || null,
        original_available: Boolean(clean(source.drive_file_id, 500)),
        memo: clean(source.memo, 4000) || null
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

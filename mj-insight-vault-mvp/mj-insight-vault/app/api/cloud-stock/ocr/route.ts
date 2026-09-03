import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { downloadGoogleDriveFile } from '@/lib/googleDriveRead';
import { runDocumentOcr } from '@/lib/vision';
import { normalizeOcrText } from '@/lib/text';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 120;

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const sourceFileId = clean(body.source_file_id, 100);
    if (!sourceFileId) return Response.json({ error: '資料IDがありません。' }, { status: 400 });

    const sourceResponse = await neonDataFetch(
      `vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}&select=id,drive_file_id,file_name,mime_type,ocr_status&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const sourceJson = await parseUpstreamJson(sourceResponse, '資料情報を取得できませんでした。');
    const source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;
    if (!source) return Response.json({ error: '対象資料が見つかりません。' }, { status: 404 });

    const mimeType = clean(source.mime_type, 200).toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      return Response.json({ error: '現在OCRできるのはJPG・PNG・WebP画像です。PDFのOCRは次段階で対応します。' }, { status: 400 });
    }

    const existingResponse = await neonDataFetch(
      `vault_articles?source_file_id=eq.${encodeURIComponent(sourceFileId)}&article_sequence=eq.0&select=id,ocr_text_raw&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const existingJson = await parseUpstreamJson(existingResponse, 'OCR済みデータの確認に失敗しました。');
    const existing = Array.isArray(existingJson) ? existingJson[0] as Record<string, unknown> | undefined : undefined;
    const existingText = existing && typeof existing.ocr_text_raw === 'string' ? existing.ocr_text_raw : '';
    if (existingText.trim()) {
      return Response.json({
        ok: true,
        already_processed: true,
        source_file_id: sourceFileId,
        ocr_char_count: existingText.length
      });
    }

    await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, jwt, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ocr_status: 'processing', updated_at: new Date().toISOString() })
    }).then((response) => parseUpstreamJson(response, 'OCR状態を更新できませんでした。'));

    try {
      const buffer = await downloadGoogleDriveFile(clean(source.drive_file_id, 256));
      const ocr = await runDocumentOcr(buffer);
      const ocrText = normalizeOcrText(ocr.text || '');

      const articleResponse = await neonDataFetch(
        'vault_articles?on_conflict=source_file_id,article_sequence&select=id,source_file_id,article_sequence,ocr_text_raw,verification_status',
        jwt,
        {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            source_file_id: sourceFileId,
            article_sequence: 0,
            title: clean(source.file_name, 500) || 'ページ全体OCR',
            ocr_text_raw: ocrText,
            ocr_text_verified: null,
            verification_version: 'drive-neon-source-ocr-v1',
            verification_status: 'source_ocr_raw',
            confidence: null,
            updated_at: new Date().toISOString()
          })
        }
      );
      await parseUpstreamJson(articleResponse, 'OCR本文をNeonへ保存できませんでした。');

      const doneResponse = await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, jwt, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ ocr_status: 'done', updated_at: new Date().toISOString() })
      });
      await parseUpstreamJson(doneResponse, 'OCR完了状態を保存できませんでした。');

      return Response.json({
        ok: true,
        already_processed: false,
        source_file_id: sourceFileId,
        file_name: source.file_name,
        ocr_char_count: ocrText.length,
        searchable: true,
        downstream_started: false
      });
    } catch (error) {
      await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, jwt, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ ocr_status: 'failed', updated_at: new Date().toISOString() })
      }).catch(() => null);
      throw error;
    }
  } catch (error) {
    return jsonError(error);
  }
}

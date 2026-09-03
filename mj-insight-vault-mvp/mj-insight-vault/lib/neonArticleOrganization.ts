import { downloadGoogleDriveFile } from '@/lib/googleDriveRead';
import { segmentArticlesFromImage } from '@/lib/articleSegmentation';
import { neonDataFetch, parseUpstreamJson } from '@/lib/neonCloud';

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validDate(value: unknown) {
  const text = clean(value, 32);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

export async function organizeNeonSourceArticles(input: {
  jwt: string;
  sourceFileId: string;
  force?: boolean;
}) {
  const { jwt, sourceFileId, force = false } = input;

  const sourceResponse = await neonDataFetch(
    `vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}&select=id,drive_file_id,file_name,mime_type,article_date,source_status,ocr_status&limit=1`,
    jwt,
    { method: 'GET' }
  );
  const sourceJson = await parseUpstreamJson(sourceResponse, '記事整理の対象資料を取得できませんでした。');
  const source = Array.isArray(sourceJson) ? sourceJson[0] as Record<string, unknown> | undefined : undefined;
  if (!source) throw new Error('記事整理の対象資料が見つかりません。');
  if (clean(source.source_status, 100) === 'e2e_test') {
    return { source_file_id: sourceFileId, article_count: 0, already_organized: true, skipped_test: true };
  }

  const mimeType = clean(source.mime_type, 200).toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new Error('現在、記事整理できるのはJPG・PNG・WebP画像です。');
  }

  const existingResponse = await neonDataFetch(
    `vault_articles?source_file_id=eq.${encodeURIComponent(sourceFileId)}&article_sequence=gt.0&select=id,article_sequence,title&order=article_sequence.asc&limit=20`,
    jwt,
    { method: 'GET' }
  );
  const existingJson = await parseUpstreamJson(existingResponse, '既存の記事整理結果を確認できませんでした。');
  const existing = Array.isArray(existingJson) ? existingJson as Array<Record<string, unknown>> : [];
  if (existing.length && !force) {
    return {
      source_file_id: sourceFileId,
      article_count: existing.length,
      already_organized: true,
      articles: existing
    };
  }

  const pageResponse = await neonDataFetch(
    `vault_articles?source_file_id=eq.${encodeURIComponent(sourceFileId)}&article_sequence=eq.0&select=id,ocr_text_raw,ocr_text_verified&limit=1`,
    jwt,
    { method: 'GET' }
  );
  const pageJson = await parseUpstreamJson(pageResponse, 'ページOCRを取得できませんでした。');
  const page = Array.isArray(pageJson) ? pageJson[0] as Record<string, unknown> | undefined : undefined;
  const pageOcr = clean(page?.ocr_text_verified, 100000) || clean(page?.ocr_text_raw, 100000);
  if (!pageOcr) throw new Error('先にOCRを実行してください。');

  const imageBuffer = await downloadGoogleDriveFile(clean(source.drive_file_id, 256));
  const candidates = await segmentArticlesFromImage({
    ocrText: pageOcr,
    imageBuffer,
    mimeType
  });

  const usable = candidates.filter((candidate) => {
    if (candidate.article_type === 'caption') return false;
    return candidate.ocr_text.trim().length >= 80;
  });
  const articles = usable.length ? usable : candidates.filter((candidate) => candidate.ocr_text.trim().length > 0);
  if (!articles.length) throw new Error('記事候補を抽出できませんでした。');

  const now = new Date().toISOString();
  const rows = articles.slice(0, 8).map((article, index) => ({
    source_file_id: sourceFileId,
    article_sequence: index + 1,
    title: clean(article.headline, 1000) || `記事 ${index + 1}`,
    ocr_text_raw: article.ocr_text,
    ocr_text_verified: null,
    verification_version: 'drive-neon-article-organization-v1',
    verification_status: 'article_organized',
    confidence: null,
    updated_at: now
  }));

  const insertResponse = await neonDataFetch(
    'vault_articles?on_conflict=source_file_id,article_sequence&select=id,source_file_id,article_sequence,title,verification_status',
    jwt,
    {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(rows)
    }
  );
  const insertedJson = await parseUpstreamJson(insertResponse, '記事整理結果をNeonへ保存できませんでした。');
  const inserted = Array.isArray(insertedJson) ? insertedJson as Array<Record<string, unknown>> : [];

  const inferredDate = articles.map((article) => validDate(article.article_date)).find(Boolean) || '';
  if (!validDate(source.article_date) && inferredDate) {
    const dateResponse = await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, jwt, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ article_date: inferredDate, updated_at: now })
    });
    await parseUpstreamJson(dateResponse, '掲載日を保存できませんでした。');
  }

  return {
    source_file_id: sourceFileId,
    article_count: inserted.length || rows.length,
    already_organized: false,
    article_date: inferredDate || validDate(source.article_date) || null,
    articles: inserted.length ? inserted : rows
  };
}

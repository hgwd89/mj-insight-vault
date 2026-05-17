import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcr } from '@/lib/vision';
import { segmentArticlesFromImage } from '@/lib/articleSegmentation';
import { buildEmbeddingText, normalizeOcrText } from '@/lib/text';
import { embedText } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeKey(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[「」『』【】\[\]（）()、。,.，．・:：]/g, '')
    .trim()
    .toLowerCase();
}

function articleDuplicateKey(headline: unknown, articleDate: unknown) {
  const normalizedHeadline = normalizeKey(headline);
  const normalizedDate = String(articleDate || '').trim();
  if (!normalizedHeadline || !normalizedDate) return '';
  return `${normalizedDate}::${normalizedHeadline}`;
}

async function updateImage(imageId: string, values: Record<string, unknown>) {
  const first = await supabaseAdmin
    .from('source_images')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('id', imageId);

  if (!first.error) return;

  const fallback = await supabaseAdmin
    .from('source_images')
    .update(values)
    .eq('id', imageId);

  if (fallback.error) throw fallback.error;
}

async function updateBatch(batchId: string, values: Record<string, unknown>) {
  const first = await supabaseAdmin
    .from('upload_batches')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('id', batchId);

  if (!first.error) return;

  const fallback = await supabaseAdmin
    .from('upload_batches')
    .update(values)
    .eq('id', batchId);

  if (fallback.error) throw fallback.error;
}

async function maybeCompleteBatch(batchId: string) {
  const { data: images, error } = await supabaseAdmin
    .from('source_images')
    .select('id, ocr_status')
    .eq('batch_id', batchId);

  if (error) throw error;

  const allDone = (images || []).every((image) => ['done', 'failed', 'deleted'].includes(image.ocr_status));

  if (allDone) {
    await updateBatch(batchId, { status: 'ocr_done' });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const fallbackArticleDate = String(body.article_date || '').trim();

    const { data: image, error: imageError } = await supabaseAdmin
      .from('source_images')
      .select('*')
      .eq('id', id)
      .single();

    if (imageError) throw imageError;
    if (!image?.storage_path) return Response.json({ error: 'source image has no storage_path' }, { status: 400 });

    const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(image.storage_path);
    if (downloaded.error) throw downloaded.error;

    const arrayBuffer = await downloaded.data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = image.mime_type || downloaded.data.type || 'image/png';

    await updateImage(id, { ocr_status: 'processing', error_message: null });

    try {
      const ocr = await runDocumentOcr(buffer);
      const ocrText = normalizeOcrText(ocr.text);

      await updateImage(id, {
        ocr_status: 'done',
        ocr_text_raw: ocrText,
        ocr_json: ocr.raw,
        error_message: null
      });

      const candidates = await segmentArticlesFromImage({ ocrText, imageBuffer: buffer, mimeType });
      const candidateDates = Array.from(new Set(candidates.map((candidate) => candidate.article_date || fallbackArticleDate || '').filter(Boolean)));
      const { data: existingArticles, error: existingError } = candidateDates.length
        ? await supabaseAdmin
          .from('articles')
          .select('id, headline, article_date, status')
          .in('article_date', candidateDates)
          .neq('status', 'deleted')
        : { data: [], error: null };

      if (existingError) throw existingError;

      const existingKeys = new Map<string, { id: string; headline: string | null; article_date: string | null }>();
      for (const article of existingArticles || []) {
        const key = articleDuplicateKey(article.headline, article.article_date);
        if (key) existingKeys.set(key, article);
      }

      const createdArticles: unknown[] = [];
      const duplicateArticles: unknown[] = [];
      const seenInThisImage = new Set<string>();

      for (let idx = 0; idx < candidates.length; idx++) {
        const candidate = candidates[idx];
        const articleDate = candidate.article_date || fallbackArticleDate || null;
        const duplicateKey = articleDuplicateKey(candidate.headline, articleDate);
        const existing = duplicateKey ? existingKeys.get(duplicateKey) : undefined;
        const duplicatedInThisImage = duplicateKey ? seenInThisImage.has(duplicateKey) : false;

        if (duplicateKey) seenInThisImage.add(duplicateKey);

        if (existing || duplicatedInThisImage) {
          duplicateArticles.push({
            headline: candidate.headline,
            article_date: articleDate,
            article_index: idx,
            reason: existing ? '既存記事と同じ日付・見出し' : '同一画像内で同じ日付・見出し',
            existing_article_id: existing?.id || null,
            existing_headline: existing?.headline || null
          });
          continue;
        }

        const { data: article, error: articleError } = await supabaseAdmin
          .from('articles')
          .insert({
            batch_id: image.batch_id,
            source_image_id: id,
            headline: candidate.headline,
            article_date: articleDate,
            article_index: idx,
            ocr_text: candidate.ocr_text,
            article_type: candidate.article_type,
            has_table: candidate.has_table,
            has_chart: candidate.has_chart,
            has_image: candidate.has_image,
            status: 'ocr_done'
          })
          .select('*')
          .single();

        if (articleError) throw articleError;

        createdArticles.push(article);

        const insertedKey = articleDuplicateKey(article.headline, article.article_date);
        if (insertedKey) existingKeys.set(insertedKey, article);

        const embeddingText = buildEmbeddingText(article);
        const embedding = await embedText(embeddingText);

        if (embedding) {
          await supabaseAdmin.from('article_embeddings').insert({
            article_id: article.id,
            embedding_text: embeddingText,
            embedding_vector: embedding
          });
        }
      }

      await maybeCompleteBatch(image.batch_id);

      return Response.json({
        image: { ...image, ocr_status: 'done' },
        articles: createdArticles,
        article_count: createdArticles.length,
        duplicates: duplicateArticles,
        duplicate_count: duplicateArticles.length
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('Source image process failed:', errorMessage, error);
      await updateImage(id, { ocr_status: 'failed', error_message: errorMessage || 'Process failed with empty error message' });
      await maybeCompleteBatch(image.batch_id);
      return Response.json({ error: errorMessage, image: { ...image, ocr_status: 'failed' }, articles: [], article_count: 0, duplicates: [], duplicate_count: 0 }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

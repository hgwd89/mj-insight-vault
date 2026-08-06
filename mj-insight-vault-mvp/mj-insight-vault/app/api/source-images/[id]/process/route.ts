import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcr } from '@/lib/vision';
import { segmentArticlesFromImage } from '@/lib/articleSegmentation';
import { normalizeOcrText } from '@/lib/text';
import { commitSourceImageArticles, enrichCommittedArticles } from '@/lib/sourceImageArticleCommit';

export const runtime = 'nodejs';
export const maxDuration = 300;

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isQuotaErrorMessage(message: string) {
  const lower = message.toLowerCase();
  return lower.includes('429')
    || lower.includes('insufficient_quota')
    || lower.includes('exceeded your current quota')
    || lower.includes('billing details')
    || lower.includes('rate limit')
    || lower.includes('quota');
}

function monthKey(value: unknown) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : '';
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
  if (allDone) await updateBatch(batchId, { status: 'ocr_done' });
}

async function existingCompletedArticles(imageId: string) {
  const { data, error } = await supabaseAdmin
    .from('articles')
    .select('*')
    .eq('source_image_id', imageId)
    .not('status', 'in', '(deleted,excluded,rejected)')
    .order('article_index', { ascending: true });
  if (error) throw error;
  return data || [];
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

    if (image.ocr_status === 'done') {
      const existing = await existingCompletedArticles(id);
      if (existing.length) {
        return Response.json({
          image,
          articles: existing,
          article_count: existing.length,
          duplicates: [],
          duplicate_count: 0,
          already_processed: true
        });
      }
    }

    const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(image.storage_path);
    if (downloaded.error) throw downloaded.error;

    const arrayBuffer = await downloaded.data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = image.mime_type || downloaded.data.type || 'image/png';

    await updateImage(id, { ocr_status: 'processing', error_message: null });

    try {
      const ocr = await runDocumentOcr(buffer);
      const ocrText = normalizeOcrText(ocr.text);
      const candidates = await segmentArticlesFromImage({ ocrText, imageBuffer: buffer, mimeType });

      const committed = await commitSourceImageArticles({
        imageId: id,
        candidates,
        fallbackArticleDate,
        replaceExisting: false
      });

      await updateImage(id, {
        ocr_status: 'done',
        ocr_text_raw: ocrText,
        ocr_json: ocr.raw,
        error_message: null
      });
      await maybeCompleteBatch(image.batch_id);

      const enrichment = await enrichCommittedArticles(committed.created_articles);
      const affectedMonths = Array.from(new Set(
        candidates.map((candidate) => monthKey(candidate.article_date || fallbackArticleDate)).filter(Boolean)
      ));

      return Response.json({
        image: { ...image, ocr_status: 'done' },
        articles: committed.created_articles,
        article_count: committed.created_count,
        duplicates: committed.duplicate_candidates,
        duplicate_count: committed.duplicate_count,
        retired_article_ids: committed.retired_article_ids,
        stale_rollup_months: affectedMonths,
        stale_rollup_updated: affectedMonths.length,
        enrichment,
        atomic_commit: true
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const isQuota = isQuotaErrorMessage(errorMessage);
      console.error('Source image process failed:', errorMessage, error);
      await updateImage(id, { ocr_status: 'failed', error_message: errorMessage || 'Process failed with empty error message' });
      await maybeCompleteBatch(image.batch_id);
      return Response.json(
        {
          error: isQuota
            ? `OpenAI API quota exceeded. OCRを停止しました。OpenAIのBilling/Usage/Rate limitを確認してください。元エラー: ${errorMessage}`
            : errorMessage,
          error_type: isQuota ? 'openai_quota' : 'process_failed',
          retryable: !isQuota,
          image: { ...image, ocr_status: 'failed' },
          articles: [],
          article_count: 0,
          duplicates: [],
          duplicate_count: 0,
          atomic_commit: true
        },
        { status: isQuota ? 429 : 500 }
      );
    }
  } catch (error) {
    return jsonError(error);
  }
}

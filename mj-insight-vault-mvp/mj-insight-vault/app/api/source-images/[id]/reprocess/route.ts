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

async function getFallbackArticleDate(imageId: string) {
  const { data, error } = await supabaseAdmin
    .from('articles')
    .select('article_date')
    .eq('source_image_id', imageId)
    .not('article_date', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('Fallback article_date lookup failed:', error.message);
    return null;
  }

  return data?.[0]?.article_date || null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);

    const { id } = await params;

    const { data: image, error: imageError } = await supabaseAdmin
      .from('source_images')
      .select('*')
      .eq('id', id)
      .single();

    if (imageError) throw imageError;
    if (!image?.storage_path) {
      return Response.json({ error: 'source image has no storage_path' }, { status: 400 });
    }

    const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(image.storage_path);
    if (downloaded.error) throw downloaded.error;

    const arrayBuffer = await downloaded.data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = image.mime_type || downloaded.data.type || 'image/png';
    const fallbackArticleDate = await getFallbackArticleDate(id);

    await updateImage(id, { ocr_status: 'processing', error_message: null });

    try {
      const ocr = await runDocumentOcr(buffer);
      const ocrText = normalizeOcrText(ocr.text);
      const candidates = await segmentArticlesFromImage({ ocrText, imageBuffer: buffer, mimeType });

      const committed = await commitSourceImageArticles({
        imageId: id,
        candidates,
        fallbackArticleDate,
        replaceExisting: true
      });

      await updateImage(id, {
        ocr_status: 'done',
        ocr_text_raw: ocrText,
        ocr_json: ocr.raw,
        error_message: null
      });

      const enrichment = await enrichCommittedArticles(committed.created_articles);
      const affectedMonths = Array.from(new Set([
        monthKey(fallbackArticleDate),
        ...candidates.map((candidate) => monthKey(candidate.article_date || fallbackArticleDate))
      ].filter(Boolean)));

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
      console.error('Source image reprocess failed:', errorMessage, error);
      await updateImage(id, { ocr_status: 'failed', error_message: errorMessage || 'Reprocess failed with empty error message' });
      return Response.json({
        error: errorMessage,
        error_type: 'reprocess_failed',
        retryable: true,
        old_articles_preserved: true,
        atomic_commit: true
      }, { status: 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcr } from '@/lib/vision';
import { normalizeOcrText } from '@/lib/text';

export const runtime = 'nodejs';
export const maxDuration = 120;

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
  return lower.includes('429') || lower.includes('quota') || lower.includes('rate limit');
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

async function maybeCompleteBatch(batchId: string | null) {
  if (!batchId) return;
  const { data: images, error } = await supabaseAdmin
    .from('source_images')
    .select('id,ocr_status')
    .eq('batch_id', batchId);
  if (error) throw error;

  const rows = images || [];
  if (rows.length > 0 && rows.every((image) => ['done', 'failed', 'deleted'].includes(String(image.ocr_status || '')))) {
    await updateBatch(batchId, { status: 'ocr_done' });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireAppPassword(req);
    const { id } = await params;

    const { data: image, error: imageError } = await supabaseAdmin
      .from('source_images')
      .select('id,batch_id,file_name,storage_path,mime_type,ocr_status,ocr_text_raw,error_message,created_at')
      .eq('id', id)
      .single();

    if (imageError) throw imageError;
    if (!image?.storage_path) return Response.json({ error: 'source image has no storage_path' }, { status: 400 });

    if (String(image.ocr_status || '') === 'done') {
      const existingText = String(image.ocr_text_raw || '');
      return Response.json({
        mode: 'ocr_only',
        already_processed: true,
        image,
        ocr_text_raw: existingText,
        ocr_char_count: existingText.length,
        raw_provider_json_written: false,
        articles_created: 0
      });
    }

    const claim = await supabaseAdmin
      .from('source_images')
      .update({ ocr_status: 'processing', error_message: null })
      .eq('id', id)
      .in('ocr_status', ['queued', 'failed'])
      .select('id')
      .maybeSingle();

    if (claim.error) throw claim.error;
    if (!claim.data) {
      return Response.json({
        error: 'OCR is already processing or this image is not eligible for OCR-only processing.',
        mode: 'ocr_only',
        image_status: image.ocr_status
      }, { status: 409 });
    }

    try {
      const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(image.storage_path);
      if (downloaded.error) throw downloaded.error;

      const buffer = Buffer.from(await downloaded.data.arrayBuffer());
      const ocr = await runDocumentOcr(buffer);
      const ocrText = normalizeOcrText(ocr.text);

      await updateImage(id, {
        ocr_status: 'done',
        ocr_text_raw: ocrText,
        error_message: null
      });
      await maybeCompleteBatch(image.batch_id ? String(image.batch_id) : null);

      return Response.json({
        mode: 'ocr_only',
        already_processed: false,
        image: { ...image, ocr_status: 'done', ocr_text_raw: ocrText, error_message: null },
        ocr_text_raw: ocrText,
        ocr_char_count: ocrText.length,
        raw_provider_json_written: false,
        articles_created: 0
      });
    } catch (error) {
      const message = getErrorMessage(error) || 'OCR-only processing failed with empty error message';
      const quota = isQuotaErrorMessage(message);
      console.error('OCR-only source image processing failed:', message);
      await updateImage(id, { ocr_status: 'failed', error_message: message }).catch(() => undefined);
      await maybeCompleteBatch(image.batch_id ? String(image.batch_id) : null).catch(() => undefined);
      return Response.json({
        error: message,
        error_type: quota ? 'ocr_provider_quota' : 'ocr_only_failed',
        retryable: !quota,
        mode: 'ocr_only'
      }, { status: quota ? 429 : 500 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

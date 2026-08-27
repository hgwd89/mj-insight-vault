import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcr } from '@/lib/vision';
import { normalizeOcrText } from '@/lib/text';

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
  if (!batchId) return;
  const { data: images, error } = await supabaseAdmin
    .from('source_images')
    .select('id, ocr_status')
    .eq('batch_id', batchId);

  if (error) throw error;
  const allDone = (images || []).every((image) => ['done', 'failed', 'deleted'].includes(image.ocr_status));
  if (allDone) await updateBatch(batchId, { status: 'ocr_done' });
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

    if (image.ocr_status === 'done' && String(image.ocr_text_raw || '').trim()) {
      return Response.json({
        image,
        mode: 'ocr_only',
        already_processed: true,
        article_processing_started: false,
        ocr_text: image.ocr_text_raw
      });
    }

    const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(image.storage_path);
    if (downloaded.error) throw downloaded.error;

    const arrayBuffer = await downloaded.data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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
      await maybeCompleteBatch(String(image.batch_id || ''));

      return Response.json({
        image: { ...image, ocr_status: 'done' },
        mode: 'ocr_only',
        already_processed: false,
        article_processing_started: false,
        ocr_text: ocrText
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('Source image OCR-only failed:', errorMessage, error);
      await updateImage(id, {
        ocr_status: 'failed',
        error_message: errorMessage || 'OCR failed with empty error message'
      });
      await maybeCompleteBatch(String(image.batch_id || ''));
      return Response.json(
        {
          error: errorMessage || 'OCR failed',
          error_type: 'ocr_only_failed',
          retryable: true,
          image: { ...image, ocr_status: 'failed' },
          mode: 'ocr_only',
          article_processing_started: false
        },
        { status: 500 }
      );
    }
  } catch (error) {
    return jsonError(error);
  }
}

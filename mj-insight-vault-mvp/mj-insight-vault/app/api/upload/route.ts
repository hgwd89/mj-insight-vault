import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_FILES = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function isHeicFile(file: File) {
  const lowerName = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return type.includes('heic') || type.includes('heif') || lowerName.endsWith('.heic') || lowerName.endsWith('.heif');
}

function getMimeType(file: File) {
  const fileName = file.name || '';
  const lowerName = fileName.toLowerCase();

  if (file.type) return file.type;
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';

  return 'image/png';
}

function getExtension(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function validateFiles(files: File[]) {
  if (!files.length) return 'No files uploaded.';
  if (files.length > MAX_FILES) return `Upload limit is ${MAX_FILES} files.`;

  const heic = files.find(isHeicFile);
  if (heic) return `HEIC/HEIF files are not supported in this app. Please convert to JPG or PNG first: ${heic.name}`;

  const oversized = files.find((file) => file.size > MAX_FILE_BYTES);
  if (oversized) return `File is too large. Each image must be 4MB or less: ${oversized.name}`;

  return '';
}

async function updateBatchStatus(batchId: string, status: string) {
  const first = await supabaseAdmin
    .from('upload_batches')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', batchId)
    .select('*')
    .single();

  if (!first.error) return first.data;

  const fallback = await supabaseAdmin
    .from('upload_batches')
    .update({ status })
    .eq('id', batchId)
    .select('*')
    .single();

  if (fallback.error) throw fallback.error;
  return fallback.data;
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const form = await req.formData();
    const memo = String(form.get('memo') || '').trim();
    const fallbackArticleDate = String(form.get('article_date') || '').trim();
    const files = form.getAll('files').filter((f): f is File => f instanceof File);

    const validationError = validateFiles(files);
    if (validationError) return Response.json({ error: validationError }, { status: 400 });

    const { data: batch, error: batchError } = await supabaseAdmin
      .from('upload_batches')
      .insert({ memo, image_count: files.length, status: 'queued' })
      .select('*')
      .single();

    if (batchError) throw batchError;

    const createdImages: unknown[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = getMimeType(file);
      const ext = getExtension(mimeType);
      const displayFileName = file.name || `${String(i + 1).padStart(2, '0')}.${ext}`;
      const storagePath = `${batch.id}/${String(i + 1).padStart(2, '0')}_${crypto.randomUUID()}.${ext}`;

      const upload = await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false
      });

      if (upload.error) throw upload.error;

      const { data: image, error: imageError } = await supabaseAdmin
        .from('source_images')
        .insert({
          batch_id: batch.id,
          file_name: displayFileName,
          storage_path: storagePath,
          mime_type: mimeType,
          ocr_status: 'queued',
          error_message: fallbackArticleDate ? `queued; article_date=${fallbackArticleDate}` : 'queued'
        })
        .select('*')
        .single();

      if (imageError) throw imageError;
      createdImages.push(image);
    }

    const updatedBatch = await updateBatchStatus(batch.id, 'queued');

    return Response.json({
      batch: updatedBatch || batch,
      images: createdImages,
      articles: [],
      summary: {
        batch_id: batch.id,
        image_count: files.length,
        success_image_count: 0,
        failed_image_count: 0,
        article_count: 0,
        date_unknown_count: 0,
        queued_image_count: files.length,
        mode: 'queued'
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

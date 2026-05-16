import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcr } from '@/lib/vision';
import { segmentArticlesFromImage } from '@/lib/articleSegmentation';
import { buildEmbeddingText, normalizeOcrText } from '@/lib/text';
import { embedText } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_FILES = 20;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

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

async function updateSourceImage(imageId: string, values: Record<string, unknown>) {
  const first = await supabaseAdmin
    .from('source_images')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('id', imageId)
    .select('*')
    .single();

  if (!first.error) return first.data;

  const fallback = await supabaseAdmin
    .from('source_images')
    .update(values)
    .eq('id', imageId)
    .select('*')
    .single();

  if (fallback.error) throw fallback.error;
  return fallback.data;
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
      .insert({ memo, image_count: files.length, status: 'processing' })
      .select('*')
      .single();

    if (batchError) throw batchError;

    const createdArticles: any[] = [];
    const createdImages: any[] = [];

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
          ocr_status: 'processing'
        })
        .select('*')
        .single();

      if (imageError) throw imageError;
      createdImages.push(image);

      try {
        const ocr = await runDocumentOcr(buffer);
        const ocrText = normalizeOcrText(ocr.text);

        const doneImage = await updateSourceImage(image.id, {
          ocr_status: 'done',
          ocr_text_raw: ocrText,
          ocr_json: ocr.raw,
          error_message: null
        });

        const imageIndex = createdImages.findIndex((img) => img.id === image.id);
        if (imageIndex >= 0) createdImages[imageIndex] = doneImage;

        const candidates = await segmentArticlesFromImage({ ocrText, imageBuffer: buffer, mimeType });

        for (let idx = 0; idx < candidates.length; idx++) {
          const candidate = candidates[idx];
          const articleDate = candidate.article_date || fallbackArticleDate || null;

          const { data: article, error: articleError } = await supabaseAdmin
            .from('articles')
            .insert({
              batch_id: batch.id,
              source_image_id: image.id,
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

          const embeddingText = buildEmbeddingText(article);
          const embedding = await embedText(embeddingText);

          if (embedding) {
            const { error: embeddingError } = await supabaseAdmin.from('article_embeddings').insert({
              article_id: article.id,
              embedding_text: embeddingText,
              embedding_vector: embedding
            });

            if (embeddingError) console.error('Embedding insert failed:', embeddingError.message);
          }
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error('OCR/article pipeline failed:', errorMessage, error);

        const failedImage = await updateSourceImage(image.id, {
          ocr_status: 'failed',
          error_message: errorMessage || 'OCR/article pipeline failed with empty error message'
        });

        const idx = createdImages.findIndex((img) => img.id === image.id);
        if (idx >= 0) createdImages[idx] = failedImage;
      }
    }

    const finalBatchStatus = createdArticles.length > 0 ? 'ocr_done' : 'failed';
    const updatedBatch = await updateBatchStatus(batch.id, finalBatchStatus);

    const successImageCount = createdImages.filter((img) => img.ocr_status === 'done').length;
    const failedImageCount = createdImages.filter((img) => img.ocr_status === 'failed').length;
    const dateUnknownCount = createdArticles.filter((article) => !article.article_date).length;

    return Response.json({
      batch: updatedBatch || batch,
      images: createdImages,
      articles: createdArticles,
      summary: {
        batch_id: batch.id,
        image_count: files.length,
        success_image_count: successImageCount,
        failed_image_count: failedImageCount,
        article_count: createdArticles.length,
        date_unknown_count: dateUnknownCount
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}

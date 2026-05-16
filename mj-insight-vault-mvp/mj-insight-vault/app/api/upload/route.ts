import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcr } from '@/lib/vision';
import { segmentArticlesFromImage } from '@/lib/articleSegmentation';
import { buildEmbeddingText, normalizeOcrText } from '@/lib/text';
import { embedText } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
  if (!files.length) {
    return 'No files uploaded.';
  }

  if (files.length > MAX_FILES) {
    return `Upload limit is ${MAX_FILES} files.`;
  }

  const heic = files.find(isHeicFile);
  if (heic) {
    return `HEIC/HEIF files are not supported in this app. Please convert to JPG or PNG first: ${heic.name}`;
  }

  const oversized = files.find((file) => file.size > MAX_FILE_BYTES);
  if (oversized) {
    return `File is too large. Each image must be 4MB or less: ${oversized.name}`;
  }

  return '';
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const form = await req.formData();
    const memo = String(form.get('memo') || '').trim();
    const files = form
      .getAll('files')
      .filter((f): f is File => f instanceof File);

    const validationError = validateFiles(files);
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 });
    }

    const { data: batch, error: batchError } = await supabaseAdmin
      .from('upload_batches')
      .insert({
        memo,
        image_count: files.length,
        status: 'processing'
      })
      .select('*')
      .single();

    if (batchError) throw batchError;

    const createdArticles: unknown[] = [];
    const createdImages: unknown[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const mimeType = getMimeType(file);
      const ext = getExtension(mimeType);
      const displayFileName = file.name || `${String(i + 1).padStart(2, '0')}.${ext}`;
      const storagePath = `${batch.id}/${String(i + 1).padStart(2, '0')}_${crypto.randomUUID()}.${ext}`;

      const upload = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, buffer, {
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

        await supabaseAdmin
          .from('source_images')
          .update({
            ocr_status: 'done',
            ocr_text_raw: ocrText,
            ocr_json: ocr.raw,
            error_message: null
          })
          .eq('id', image.id);

        const candidates = await segmentArticlesFromImage({
          ocrText,
          imageBuffer: buffer,
          mimeType
        });

        for (let idx = 0; idx < candidates.length; idx++) {
          const candidate = candidates[idx];

          const { data: article, error: articleError } = await supabaseAdmin
            .from('articles')
            .insert({
              batch_id: batch.id,
              source_image_id: image.id,
              headline: candidate.headline,
              article_date: candidate.article_date || null,
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
            await supabaseAdmin.from('article_embeddings').insert({
              article_id: article.id,
              embedding_text: embeddingText,
              embedding_vector: embedding
            });
          }
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);

        console.error('OCR/article pipeline failed:', errorMessage, error);

        await supabaseAdmin
          .from('source_images')
          .update({
            ocr_status: 'failed',
            error_message: errorMessage || 'OCR/article pipeline failed with empty error message'
          })
          .eq('id', image.id);
      }
    }

    await supabaseAdmin
      .from('upload_batches')
      .update({
        status: 'ocr_done',
        updated_at: new Date().toISOString()
      })
      .eq('id', batch.id);

    return Response.json({
      batch,
      images: createdImages,
      articles: createdArticles
    });
  } catch (error) {
    return jsonError(error);
  }
}

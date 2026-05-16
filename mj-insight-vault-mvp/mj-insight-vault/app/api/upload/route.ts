import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcr } from '@/lib/vision';
import { segmentArticles } from '@/lib/articleSegmentation';
import { buildEmbeddingText, normalizeOcrText } from '@/lib/text';
import { embedText } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);

    const form = await req.formData();
    const memo = String(form.get('memo') || '').trim();
    const files = form
      .getAll('files')
      .filter((f): f is File => f instanceof File);

    if (!files.length) {
      return Response.json({ error: 'No files uploaded.' }, { status: 400 });
    }

    if (files.length > 20) {
      return Response.json({ error: 'Upload limit is 20 files.' }, { status: 400 });
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

      const mimeType = file.type || 'image/png';

      const ext =
        mimeType === 'image/jpeg'
          ? 'jpg'
          : mimeType === 'image/png'
            ? 'png'
            : mimeType === 'image/webp'
              ? 'webp'
              : 'png';

      const path = `${batch.id}/${String(i + 1).padStart(2, '0')}_${crypto.randomUUID()}.${ext}`;

      const upload = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .upload(path, buffer, {
          contentType: mimeType,
          upsert: false
        });

      if (upload.error) throw upload.error;

      const { data: image, error: imageError } = await supabaseAdmin
        .from('source_images')
        .insert({
          batch_id: batch.id,
          file_name: file.name || `${String(i + 1).padStart(2, '0')}.${ext}`,
          storage_path: path,
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
            ocr_json: ocr.raw
          })
          .eq('id', image.id);

        const candidates = await segmentArticles(ocrText);

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
        await supabaseAdmin
          .from('source_images')
          .update({
            ocr_status: 'failed',
            error_message: error instanceof Error ? error.message : 'OCR failed'
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

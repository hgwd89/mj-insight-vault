import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { runDocumentOcrBatch } from '@/lib/visionBatch';
import { buildArticleBlockComposite, type ArticleBlockRect } from '@/lib/articleCrop';
import { buildArticleBlockReadingPiecesV17 } from '@/lib/articleBlockReadingV17';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const GOOGLE_IMAGE_BATCH = 16;

type JsonRecord = Record<string, unknown>;
type ArticleInput = {
  article_id: string;
  crop_version: string;
  crop_spec_sha256: string;
  crop_image_sha256: string;
  source_mode: string;
  source_image_sha256: string;
  block_rects: ArticleBlockRect[];
};

function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }

function parseArticles(value: unknown): ArticleInput[] {
  if (!Array.isArray(value)) throw new Error('OCR segment Google v14 articles payload is invalid.');
  return value.map((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.block_rects)) throw new Error('OCR segment Google v14 article payload is invalid.');
    const article: ArticleInput = {
      article_id: text(raw.article_id),
      crop_version: text(raw.crop_version),
      crop_spec_sha256: text(raw.crop_spec_sha256),
      crop_image_sha256: text(raw.crop_image_sha256),
      source_mode: text(raw.source_mode),
      source_image_sha256: text(raw.source_image_sha256),
      block_rects: raw.block_rects.map((rect) => {
        if (!isRecord(rect)) throw new Error('OCR segment Google v14 block rectangle is invalid.');
        return { block_index:Number(rect.block_index),x_min:Number(rect.x_min),y_min:Number(rect.y_min),x_max:Number(rect.x_max),y_max:Number(rect.y_max) };
      })
    };
    if (!article.article_id || article.crop_version !== 'article_geometry_mask_composite_v3' || !article.crop_spec_sha256 || !article.crop_image_sha256 || !article.source_image_sha256 || !article.block_rects.length) {
      throw new Error(`OCR segment Google v14 article binding is incomplete: ${article.article_id || 'unknown'}`);
    }
    return article;
  });
}

async function status() {
  const { data: jobs, error: jobsError } = await supabaseAdmin.from('ocr_consensus_jobs_v11').select('id,status,article_count,is_canary').eq('is_canary', true);
  if (jobsError) throw jobsError;
  const ids = (jobs || []).map((row) => text(row.id)).filter(Boolean);
  let probes: Array<{ job_id: string; article_id: string }> = [];
  if (ids.length) {
    const { data, error } = await supabaseAdmin.from('ocr_segment_google_probes_v14').select('job_id,article_id').in('job_id', ids);
    if (error) throw error;
    probes = (data || []).map((row) => ({ job_id:text(row.job_id), article_id:text(row.article_id) }));
  }
  return {
    canary_jobs: (jobs || []).length,
    expected_articles: (jobs || []).reduce((sum, row) => sum + Number(row.article_count || 0), 0),
    probed_articles: probes.length,
    job_statuses: (jobs || []).map((row) => ({ id:row.id,status:row.status,article_count:row.article_count }))
  };
}

async function runOne() {
  const { data: jobs, error: jobsError } = await supabaseAdmin.from('ocr_consensus_jobs_v11')
    .select('id,status,article_count,is_canary').eq('is_canary', true).in('status', ['needs_review','queued','completed']).order('created_at', { ascending:true });
  if (jobsError) throw jobsError;

  for (const job of jobs || []) {
    const jobId = text(job.id);
    if (!jobId) continue;
    const { data: payload, error: inputError } = await supabaseAdmin.rpc('get_ocr_segment_google_canary_input_v14', { p_job_id:jobId });
    if (inputError) throw inputError;
    if (!isRecord(payload) || !isRecord(payload.source)) throw new Error('OCR segment Google v14 input payload is invalid.');
    const articles = parseArticles(payload.articles);
    const { data: existing, error: existingError } = await supabaseAdmin.from('ocr_segment_google_probes_v14').select('article_id').eq('job_id',jobId);
    if (existingError) throw existingError;
    const done = new Set((existing || []).map((row) => text(row.article_id)).filter(Boolean));
    const article = articles.find((item) => !done.has(item.article_id));
    if (!article) continue;

    const source = payload.source;
    const storagePath = text(source.storage_path);
    const width = Number(source.width || 0), height = Number(source.height || 0);
    if (!storagePath || width < 1 || height < 1) throw new Error('OCR segment Google v14 source metadata is incomplete.');
    const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
    if (downloaded.error || !downloaded.data) throw downloaded.error || new Error('OCR segment Google v14 source download returned no data.');
    const image = Buffer.from(await downloaded.data.arrayBuffer());
    const sourceImageSha256 = sha256(image);
    if (sourceImageSha256 !== article.source_image_sha256) throw new Error(`OCR segment Google v14 source image binding changed: ${article.article_id}`);

    const composite = await buildArticleBlockComposite({ imageBuffer:image,expectedWidth:width,expectedHeight:height,articleId:article.article_id,rects:article.block_rects });
    if (composite.cropSpecSha256 !== article.crop_spec_sha256 || composite.cropImageSha256 !== article.crop_image_sha256) {
      throw new Error(`OCR segment Google v14 crop fingerprint changed: ${article.article_id}`);
    }

    const reading = await buildArticleBlockReadingPiecesV17({ imageBuffer:image,sourceWidth:width,sourceHeight:height,articleId:article.article_id,rects:article.block_rects });
    if (!reading.pieces.length) throw new Error(`OCR segment Google v14 produced no block-local reading pieces: ${article.article_id}`);
    const results: Awaited<ReturnType<typeof runDocumentOcrBatch>> = [];
    for (let offset = 0; offset < reading.pieces.length; offset += GOOGLE_IMAGE_BATCH) {
      const chunk = reading.pieces.slice(offset, offset + GOOGLE_IMAGE_BATCH);
      const batch = await runDocumentOcrBatch(chunk.map((piece) => piece.buffer));
      if (batch.length !== chunk.length) throw new Error(`OCR segment Google v14 response count mismatch: ${article.article_id}`);
      results.push(...batch);
    }
    if (results.length !== reading.pieces.length) throw new Error(`OCR segment Google v14 total response count mismatch: ${article.article_id}`);
    const pieceTexts = results.map((result) => text(result.text));
    const combined = pieceTexts.filter(Boolean).join('\n').trim();
    if (!combined) throw new Error(`OCR segment Google v14 returned empty text: ${article.article_id}`);

    const row = {
      job_id:jobId,
      article_id:article.article_id,
      segmentation_version:reading.version,
      segmentation_spec_sha256:reading.readingSpecSha256,
      segment_count:reading.pieces.length,
      source_image_sha256:sourceImageSha256,
      crop_image_sha256:composite.cropImageSha256,
      google_segment_text:combined,
      google_segment_text_sha256:sha256(combined),
      google_response_sha256:sha256(JSON.stringify(results.map((result) => result.raw)))
    };
    const { error: writeError } = await supabaseAdmin.from('ocr_segment_google_probes_v14').upsert(row, { onConflict:'job_id,article_id' });
    if (writeError) throw writeError;
    return {
      status:'stored',job_id:jobId,article_id:article.article_id,segment_count:reading.pieces.length,text_length:combined.length,
      segmentation_version:reading.version,segmentation_spec_sha256:reading.readingSpecSha256,google_segment_text_sha256:row.google_segment_text_sha256,
      piece_layout:reading.pieces.map((piece) => ({ sequence:piece.sequence,block_index:piece.blockIndex,block_sequence:piece.blockSequence,piece_sequence:piece.pieceSequence,piece_count:piece.pieceCount,kind:piece.kind }))
    };
  }
  return { status:'complete' };
}

export async function POST(req: NextRequest) {
  try { requireAppPassword(req); return Response.json({ ok:true,result:await runOne(),status:await status() }); }
  catch (error) { return jsonError(error); }
}

export async function GET(req: NextRequest) {
  try { requireAppPassword(req); return Response.json({ ok:true,status:await status() }); }
  catch (error) { return jsonError(error); }
}

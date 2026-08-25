import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { getOpenAIKey } from '@/lib/openai';
import { buildArticleBlockComposite, type ArticleBlockRect } from '@/lib/articleCrop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const ALLOWED_JOBS = new Set([
  '034d946f-43ab-405c-a528-13656e0396cf',
  '648ed819-32a8-4564-aa6e-6470663daed8'
]);
const TIMEOUT_MS = 150_000;

type JsonRecord = Record<string, unknown>;
function text(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function extractResponseText(responseJson: unknown) {
  const json = responseJson as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  return (json.output || []).flatMap((item) => item.content || []).map((item) => text(item.text)).filter(Boolean).join('\n').trim();
}

async function loadCanary(jobId: string, articleId: string) {
  if (!ALLOWED_JOBS.has(jobId)) throw new Error('OCR independent canary job is not allowlisted.');

  const { data: job, error: jobError } = await supabaseAdmin
    .from('ocr_verification_page_jobs_v2')
    .select('id,partition_job_id,evidence_source_image_id')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) throw new Error('OCR independent canary job not found.');

  const { data: materialized, error: materializedError } = await supabaseAdmin
    .from('source_region_materialization_receipts_v6')
    .select('inventory_job_id')
    .eq('partition_job_id', job.partition_job_id)
    .maybeSingle();
  if (materializedError) throw materializedError;
  if (!materialized?.inventory_job_id) throw new Error('OCR independent canary materialization receipt missing.');

  const { data: inventory, error: inventoryError } = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('page_identity_source_image_id,inventory_source_image_id,source_ocr_json_sha256')
    .eq('id', materialized.inventory_job_id)
    .maybeSingle();
  if (inventoryError) throw inventoryError;
  if (!inventory) throw new Error('OCR independent canary inventory job missing.');

  const { data: recovery, error: recoveryError } = await supabaseAdmin
    .from('source_page_ocr_recovery_receipts_v1')
    .select('job_id')
    .eq('page_identity_source_image_id', inventory.page_identity_source_image_id)
    .eq('source_image_id', inventory.inventory_source_image_id)
    .eq('recovered_ocr_fingerprint', inventory.source_ocr_json_sha256)
    .eq('status', 'passed')
    .maybeSingle();
  if (recoveryError) throw recoveryError;
  if (!recovery?.job_id) throw new Error('OCR independent canary recovery receipt missing.');

  const { data: assignments, error: assignmentError } = await supabaseAdmin
    .from('source_inventory_block_assignments_v7')
    .select('block_index')
    .eq('inventory_job_id', materialized.inventory_job_id)
    .eq('article_id', articleId)
    .eq('assignment_kind', 'article');
  if (assignmentError) throw assignmentError;
  const blockIndices = [...new Set((assignments || []).map((row) => Number(row.block_index)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!blockIndices.length) throw new Error('OCR independent canary article assignment missing.');

  const { data: blocks, error: blockError } = await supabaseAdmin
    .from('source_page_ocr_recovery_fresh_blocks_v1')
    .select('block_index,x_min,y_min,x_max,y_max')
    .eq('job_id', recovery.job_id)
    .in('block_index', blockIndices);
  if (blockError) throw blockError;
  if (!blocks || blocks.length !== blockIndices.length) throw new Error('OCR independent canary block geometry incomplete.');
  const rects: ArticleBlockRect[] = blocks.map((row) => ({
    block_index: Number(row.block_index), x_min: Number(row.x_min), y_min: Number(row.y_min),
    x_max: Number(row.x_max), y_max: Number(row.y_max)
  }));

  const { data: source, error: sourceError } = await supabaseAdmin
    .from('source_images')
    .select('storage_path,mime_type,width,height')
    .eq('id', job.evidence_source_image_id)
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (!source?.storage_path || !source.width || !source.height) throw new Error('OCR independent canary source image missing.');

  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(source.storage_path);
  if (downloaded.error) throw downloaded.error;
  if (!downloaded.data) throw new Error('OCR independent canary source download empty.');
  const image = Buffer.from(await downloaded.data.arrayBuffer());
  const composite = await buildArticleBlockComposite({
    imageBuffer: image,
    expectedWidth: Number(source.width),
    expectedHeight: Number(source.height),
    articleId,
    rects
  });

  const { data: crop, error: cropError } = await supabaseAdmin
    .from('ocr_verification_crop_ocr_v4')
    .select('crop_version,crop_ocr_text,crop_ocr_text_sha256,crop_image_sha256')
    .eq('job_id', jobId)
    .eq('article_id', articleId)
    .maybeSingle();
  if (cropError) throw cropError;
  if (!crop) throw new Error('OCR independent canary Google crop receipt missing.');
  if (text(crop.crop_image_sha256) !== composite.cropImageSha256) throw new Error('OCR independent canary crop fingerprint mismatch.');

  return { composite, crop, mimeType: text(source.mime_type) || 'image/jpeg' };
}

async function transcribeIndependent(jobId: string, articleId: string) {
  const input = await loadCanary(jobId, articleId);
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const model = process.env.OPENAI_OCR_VERIFY_MODEL_V2?.trim() || 'gpt-5.6-sol';

  const instructions = [
    'You are an independent high-precision OCR transcriber for Japanese newspaper and magazine article images.',
    'You have NOT been given any candidate OCR. Transcribe only from the pixels in the supplied image.',
    'The image is a geometry-preserving mask: white regions are intentionally excluded. Read only visible non-white article text.',
    'Preserve characters, punctuation, decimals, percentages, dates, prices, quantities, company names, product names, and personal names exactly as visible. Never silently normalize or repair a token you cannot actually see.',
    'Respect the visible reading order. For horizontal text read left-to-right. For Japanese vertical body text, read each column top-to-bottom and proceed across columns in the visually correct newspaper order, normally right-to-left unless the layout clearly indicates otherwise.',
    'Do not merge separate columns into one line. Use line breaks to preserve meaningful column or paragraph boundaries.',
    'confidence is the confidence that YOUR transcription is materially faithful to the visible pixels. Lower it for genuinely unreadable or cropped text, not merely because the layout is complex.',
    'visual_proper_nouns must contain only proper nouns copied verbatim from your own transcription. Use proper_noun_status=failed if an important visible proper noun cannot be read reliably.',
    'Return one result only.'
  ].join('\n');

  const schema = {
    type: 'json_schema', name: 'mj_independent_article_ocr_canary', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['article_id', 'transcription', 'confidence', 'proper_noun_status', 'visual_proper_nouns', 'reason'],
      properties: {
        article_id: { type: 'string', enum: [articleId] },
        transcription: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        proper_noun_status: { type: 'string', enum: ['passed', 'not_applicable', 'failed'] },
        visual_proper_nouns: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' }
      }
    }
  } as const;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 12000,
        instructions,
        input: [{ role: 'user', content: [
          { type: 'input_text', text: JSON.stringify({ task: 'independent_visual_ocr_canary', job_id: jobId, article_id: articleId, crop_image_sha256: input.composite.cropImageSha256 }) },
          { type: 'input_image', image_url: `data:${input.composite.mimeType};base64,${input.composite.buffer.toString('base64')}`, detail: 'high' }
        ] }],
        text: { format: schema }
      })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`OpenAI independent OCR canary failed: ${response.status} ${response.statusText} ${raw.slice(0, 1600)}`);
    let json: JsonRecord;
    try { json = JSON.parse(raw) as JsonRecord; } catch { throw new Error('OpenAI independent OCR canary response is not JSON.'); }
    const output = extractResponseText(json);
    if (!output) throw new Error('OpenAI independent OCR canary output missing.');
    let parsed: JsonRecord;
    try { parsed = JSON.parse(output) as JsonRecord; } catch { throw new Error('OpenAI independent OCR canary structured output invalid.'); }
    if (text(parsed.article_id) !== articleId || !text(parsed.transcription)) throw new Error('OpenAI independent OCR canary article/transcription invalid.');
    return {
      job_id: jobId,
      article_id: articleId,
      model,
      response_id: text(json.id),
      response_sha256: sha256(raw),
      crop_version: input.crop.crop_version,
      crop_image_sha256: input.composite.cropImageSha256,
      google_candidate_sha256: input.crop.crop_ocr_text_sha256,
      google_candidate: input.crop.crop_ocr_text,
      independent: parsed
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    if (!isRecord(body)) throw new Error('OCR independent canary body invalid.');
    const jobId = text(body.job_id), articleId = text(body.article_id);
    if (!jobId || !articleId) throw new Error('OCR independent canary job_id/article_id required.');
    return Response.json({ ok: true, result: await transcribeIndependent(jobId, articleId) });
  } catch (error) {
    return jsonError(error);
  }
}

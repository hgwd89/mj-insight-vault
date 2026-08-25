import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { getOpenAIKey, VISION_MODEL } from '@/lib/openai';
import { runDocumentOcrBatch, VisionProviderError } from '@/lib/visionBatch';
import { buildArticleBlockComposite, type ArticleBlockRect } from '@/lib/articleCrop';

type JsonRecord = Record<string, unknown>;
type PassKind = 'verifier' | 'critic';
type ArticleVisualInput = { article_id: string; source_region_id: string; region_quality_status: string; block_rects: ArticleBlockRect[] };
type Job = { id: string; partition_job_id: string; evidence_source_image_id: string; article_count: number; requires_second_pass: boolean; failure_count: number; lease_token: string };
type LoadedInput = {
  image: Buffer;
  mimeType: string;
  width: number;
  height: number;
  articles: ArticleVisualInput[];
  storagePath: string;
  sourceMode: 'ocr_derivative';
  sourceImageSha256: string;
};
type Composite = Awaited<ReturnType<typeof buildArticleBlockComposite>> & { article_id: string; region_quality_status: string };
type CropReceipt = {
  article_id: string;
  crop_spec_sha256: string;
  crop_image_sha256: string;
  source_mode: string;
  source_image_sha256: string;
  crop_ocr_text: string;
};

class StructuralOutputError extends Error {}
class ProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}

const CALL_TIMEOUT_MS = 150_000;
const LEASE_SECONDS = 360;
const GOOGLE_CROP_CHUNK = 16;
const VISION_CHUNK = 4;
const VISION_TEXT_BUDGET = 7000;

function responseFormat(articleIds: string[]) {
  return {
    type: 'json_schema',
    name: 'mj_visual_article_crop_verification',
    strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['articles'],
      properties: {
        articles: {
          type: 'array', minItems: articleIds.length, maxItems: articleIds.length,
          items: {
            type: 'object', additionalProperties: false,
            required: ['article_id', 'transcription', 'confidence', 'proper_noun_status', 'visual_proper_nouns', 'reason'],
            properties: {
              article_id: { type: 'string', enum: articleIds }, transcription: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              proper_noun_status: { type: 'string', enum: ['passed', 'not_applicable', 'failed'] },
              visual_proper_nouns: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' }
            }
          }
        }
      }
    }
  };
}

function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return text(error.message || error.error || error.details || error);
  return text(error) || 'OCR verification worker failed';
}
function extractResponseText(responseJson: unknown) {
  const json = responseJson as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  return (json.output || []).flatMap((item) => item.content || []).map((content) => text(content.text)).filter(Boolean).join('\n').trim();
}
function configuredModels() {
  const verifier = process.env.OPENAI_OCR_VERIFY_MODEL?.trim() || VISION_MODEL;
  const critic = process.env.OPENAI_OCR_VERIFY_CRITIC_MODEL?.trim() || (verifier === 'gpt-4o' ? 'gpt-4.1' : 'gpt-4o');
  if (!verifier || !critic || verifier === critic) throw new StructuralOutputError('OCR verifier and critic models must be configured and distinct.');
  return { verifier, critic };
}

async function claimJob() {
  const { data, error } = await supabaseAdmin.rpc('claim_ocr_verification_page_job_v2', { p_lease_seconds: LEASE_SECONDS });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job: Job = {
    id: text(row.id), partition_job_id: text(row.partition_job_id), evidence_source_image_id: text(row.evidence_source_image_id),
    article_count: Number(row.article_count || 0), requires_second_pass: row.requires_second_pass === true,
    failure_count: Number(row.failure_count || 0), lease_token: text(row.lease_token)
  };
  if (!job.id || !job.partition_job_id || !job.evidence_source_image_id || !job.lease_token || job.article_count < 1) {
    throw new StructuralOutputError('Invalid OCR verification job.');
  }
  return job;
}

async function loadInput(job: Job): Promise<LoadedInput> {
  const { data, error } = await supabaseAdmin.rpc('get_ocr_verification_page_input_v2', { p_job_id: job.id, p_lease_token: job.lease_token });
  if (error) throw error;
  if (!isRecord(data) || !isRecord(data.source) || !Array.isArray(data.articles)) throw new StructuralOutputError('Invalid OCR verification input payload.');
  const source = data.source;
  const articles = data.articles.map((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.block_rects)) throw new StructuralOutputError('Invalid OCR verification article region.');
    const article: ArticleVisualInput = {
      article_id: text(raw.article_id), source_region_id: text(raw.source_region_id), region_quality_status: text(raw.region_quality_status),
      block_rects: raw.block_rects.map((rect) => {
        if (!isRecord(rect)) throw new StructuralOutputError('Invalid OCR verification block rectangle.');
        return { block_index: Number(rect.block_index), x_min: Number(rect.x_min), y_min: Number(rect.y_min), x_max: Number(rect.x_max), y_max: Number(rect.y_max) };
      })
    };
    if (!article.article_id || !article.source_region_id || !article.block_rects.length) throw new StructuralOutputError('OCR verification article region is incomplete.');
    return article;
  });
  if (articles.length !== job.article_count || new Set(articles.map((article) => article.article_id)).size !== job.article_count) {
    throw new StructuralOutputError('OCR verification article set is not bijective.');
  }

  const storagePath = text(source.storage_path);
  const width = Number(source.width || 0), height = Number(source.height || 0);
  if (!storagePath || width <= 0 || height <= 0) throw new StructuralOutputError('OCR verification source image path or dimensions are missing.');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (downloaded.error) throw downloaded.error;
  if (!downloaded.data) throw new StructuralOutputError('OCR verification source image download returned no data.');
  const image = Buffer.from(await downloaded.data.arrayBuffer());
  const sourceMode = 'ocr_derivative' as const;
  const sourceImageSha256 = sha256(image);
  const { error: receiptError } = await supabaseAdmin.rpc('record_ocr_verification_source_binary_receipt_v9', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_source_mode: sourceMode,
    p_storage_path: storagePath,
    p_content_sha256: sourceImageSha256,
    p_byte_size: image.length
  });
  if (receiptError) throw receiptError;
  return {
    image,
    mimeType: text(source.mime_type) || downloaded.data.type || 'image/jpeg',
    width,
    height,
    articles,
    storagePath,
    sourceMode,
    sourceImageSha256
  };
}

async function buildComposites(input: LoadedInput, articles: ArticleVisualInput[]) {
  const result: Composite[] = [];
  for (const article of articles) {
    const composite = await buildArticleBlockComposite({ imageBuffer: input.image, expectedWidth: input.width, expectedHeight: input.height, articleId: article.article_id, rects: article.block_rects });
    result.push({ ...composite, article_id: article.article_id, region_quality_status: article.region_quality_status });
  }
  return result;
}

async function existingCropRows(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('ocr_verification_crop_ocr_v4')
    .select('article_id,crop_spec_sha256,crop_image_sha256,source_mode,source_image_sha256,crop_ocr_text')
    .eq('job_id', jobId);
  if (error) throw error;
  return new Map((data || []).map((row) => {
    const receipt: CropReceipt = {
      article_id: text(row.article_id),
      crop_spec_sha256: text(row.crop_spec_sha256),
      crop_image_sha256: text(row.crop_image_sha256),
      source_mode: text(row.source_mode),
      source_image_sha256: text(row.source_image_sha256),
      crop_ocr_text: text(row.crop_ocr_text)
    };
    return [receipt.article_id, receipt] as const;
  }));
}

async function runGoogleCropChunk(job: Job, input: LoadedInput) {
  const existing = await existingCropRows(job.id);
  const missing = input.articles.filter((article) => !existing.has(article.article_id)).slice(0, GOOGLE_CROP_CHUNK);
  if (!missing.length) return { complete: true, stored: 0 };
  const crops = await buildComposites(input, missing);
  const ocrResults = await runDocumentOcrBatch(crops.map((crop) => crop.buffer));
  if (ocrResults.length !== crops.length) throw new ProviderError('Google crop OCR response count mismatch.', true);
  const rows = crops.map((crop, index) => {
    const ocr = ocrResults[index];
    if (!ocr?.text?.trim()) throw new StructuralOutputError(`ocr_crop_v9_empty_text article=${crop.article_id}`);
    return {
      article_id: crop.article_id,
      crop_spec_sha256: crop.cropSpecSha256,
      crop_image_sha256: crop.cropImageSha256,
      google_response_sha256: sha256(JSON.stringify(ocr.raw)),
      crop_ocr_text: ocr.text,
      source_mode: input.sourceMode,
      source_image_sha256: input.sourceImageSha256
    };
  });
  const { data, error } = await supabaseAdmin.rpc('replace_ocr_crop_results_v9', { p_job_id: job.id, p_lease_token: job.lease_token, p_rows: rows });
  if (error) throw error;
  return data;
}

async function existingVisionArticleIds(jobId: string, passKind: PassKind) {
  const { data, error } = await supabaseAdmin.from('ocr_verification_transcriptions_v2').select('article_id').eq('job_id', jobId).eq('pass_kind', passKind);
  if (error) throw error;
  return new Set((data || []).map((row) => text(row.article_id)).filter(Boolean));
}

async function nextChunkIndex(jobId: string, passKind: PassKind) {
  const { data, error } = await supabaseAdmin.from('ocr_verification_vision_chunks_v4').select('chunk_index').eq('job_id', jobId).eq('pass_kind', passKind).order('chunk_index', { ascending: false }).limit(1);
  if (error) throw error;
  return Array.isArray(data) && data[0] ? Number(data[0].chunk_index) + 1 : 0;
}

async function callVisionChunk(input: { model: string; passKind: PassKind; crops: Composite[]; cropReceipts: Map<string, CropReceipt> }) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new StructuralOutputError('OPENAI_API_KEY is not configured.');
  const instructions = [
    input.passKind === 'verifier' ? 'You are a visual newspaper OCR verifier.' : 'You are a second visual newspaper OCR verifier using a different model. Make your own visual check.',
    'Each supplied image is an article-only composite made from the newspaper blocks belonging to one article.',
    'For each image you are also given an UNTRUSTED_CANDIDATE_OCR produced independently from that exact image crop.',
    'The pixels are the source of truth. Use the candidate OCR only as an alignment aid: preserve candidate characters when they are visibly supported, correct only discrepancies you can actually see, and never add words or facts that are not visible.',
    'Return a complete transcription of all visible article text in reading order. Do not summarize, paraphrase, infer missing passages, or repair content from world knowledge.',
    'The image preserves article block order with white gaps between blocks. Do not add text for the gaps.',
    'Keep visible numbers, units, company names, product names, and personal names exactly as supported by the pixels.',
    'visual_proper_nouns must list only proper nouns that also occur verbatim in your returned transcription.',
    'If proper nouns are absent, use not_applicable. If a proper noun is visibly present but not reliably legible, use failed.',
    'If the candidate OCR contains text that the image does not support, remove or correct it rather than copying it blindly.',
    'If the image cannot support a faithful transcription with at least 0.85 confidence, return the honest lower confidence; the database will stop for review.',
    'Return exactly one row for each supplied article_id and no others.'
  ].join('\n');
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: JSON.stringify({ task: 'visual_article_crop_ocr_verification', pass_kind: input.passKind, articles: input.crops.map((crop, index) => ({ article_id: crop.article_id, image_sequence: index + 1, crop_image_sha256: crop.cropImageSha256, region_quality_status: crop.region_quality_status })) }) }];
  for (const crop of input.crops) {
    const receipt = input.cropReceipts.get(crop.article_id);
    if (!receipt) throw new StructuralOutputError(`OCR crop candidate missing before Vision verification: ${crop.article_id}`);
    content.push({ type: 'input_text', text: `ARTICLE_ID=${crop.article_id}\nUNTRUSTED_CANDIDATE_OCR_START\n${receipt.crop_ocr_text}\nUNTRUSTED_CANDIDATE_OCR_END` });
    content.push({ type: 'input_image', image_url: `data:${crop.mimeType};base64,${crop.buffer.toString('base64')}`, detail: 'high' });
  }
  const promptSha = sha256([input.model, input.passKind, instructions, ...input.crops.map((crop) => {
    const receipt = input.cropReceipts.get(crop.article_id);
    return `${crop.article_id}:${crop.cropImageSha256}:${sha256(receipt?.crop_ocr_text || '')}`;
  })].join('\n---\n'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ model: input.model, store: false, max_output_tokens: 12000, instructions, input: [{ role: 'user', content }], text: { format: responseFormat(input.crops.map((crop) => crop.article_id)) } }) });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(`OpenAI OCR vision verification failed: ${response.status} ${response.statusText} ${raw.slice(0, 1800)}`, response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
    let json: JsonRecord;
    try { json = JSON.parse(raw) as JsonRecord; } catch { throw new ProviderError('OpenAI OCR vision response JSON is malformed.', true); }
    const responseId = text(json.id), output = extractResponseText(json);
    if (!responseId || !output) throw new ProviderError('OCR vision response receipt or output is missing.', true);
    let parsed: JsonRecord;
    try { parsed = JSON.parse(output) as JsonRecord; } catch { throw new StructuralOutputError('OCR vision structured output is invalid JSON.'); }
    if (!Array.isArray(parsed.articles)) throw new StructuralOutputError('OCR verification articles array missing');
    return { rows: parsed.articles, responseId, promptSha, responseSha: sha256(raw) };
  } catch (error) {
    if (error instanceof ProviderError || error instanceof StructuralOutputError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ProviderError('OpenAI OCR vision request timed out.', true);
    if (error instanceof TypeError) throw new ProviderError(`OpenAI OCR vision network failure: ${error.message}`, true);
    throw error;
  } finally { clearTimeout(timer); }
}

function chooseVisionArticles(input: LoadedInput, existing: Set<string>, receipts: Map<string, CropReceipt>) {
  const selected: ArticleVisualInput[] = [];
  let textBudget = 0;
  for (const article of input.articles) {
    if (existing.has(article.article_id)) continue;
    const receipt = receipts.get(article.article_id);
    if (!receipt) throw new StructuralOutputError(`OCR crop receipt missing before Vision verification: ${article.article_id}`);
    const chars = receipt.crop_ocr_text.length;
    if (chars <= 0) throw new StructuralOutputError(`OCR crop text missing before Vision verification: ${article.article_id}`);
    if (chars > VISION_TEXT_BUDGET) throw new StructuralOutputError(`OCR crop text exceeds exact-transcription budget: ${article.article_id} chars=${chars}`);
    if (selected.length && (selected.length >= VISION_CHUNK || textBudget + chars > VISION_TEXT_BUDGET)) break;
    selected.push(article);
    textBudget += chars;
    if (selected.length >= VISION_CHUNK) break;
  }
  return selected;
}

function visionInputBinding(crops: Composite[], receipts: Map<string, CropReceipt>) {
  const lines = crops.map((crop) => {
    const receipt = receipts.get(crop.article_id);
    if (!receipt) throw new StructuralOutputError(`OCR crop binding receipt missing: ${crop.article_id}`);
    return {
      articleId: crop.article_id,
      value: `${crop.article_id}:${receipt.crop_spec_sha256}:${receipt.crop_image_sha256}:${receipt.source_mode}:${receipt.source_image_sha256}`
    };
  }).sort((a, b) => a.articleId.localeCompare(b.articleId)).map((item) => item.value);
  return sha256(lines.join('|'));
}

async function runVisionChunk(job: Job, input: LoadedInput, passKind: PassKind, model: string) {
  const existing = await existingVisionArticleIds(job.id, passKind);
  const cropReceipts = await existingCropRows(job.id);
  const missing = chooseVisionArticles(input, existing, cropReceipts);
  if (!missing.length) return { complete: true, stored: 0 };
  const crops = await buildComposites(input, missing);
  for (const crop of crops) {
    const receipt = cropReceipts.get(crop.article_id);
    if (!receipt || receipt.crop_image_sha256 !== crop.cropImageSha256) throw new StructuralOutputError(`crop image fingerprint changed before Vision verification: ${crop.article_id}`);
    if (receipt.source_mode !== input.sourceMode || receipt.source_image_sha256 !== input.sourceImageSha256) throw new StructuralOutputError(`source binary binding changed before Vision verification: ${crop.article_id}`);
  }
  const inputBindingSha256 = visionInputBinding(crops, cropReceipts);
  const result = await callVisionChunk({ model, passKind, crops, cropReceipts });
  const expected = new Set(crops.map((crop) => crop.article_id)), seen = new Set<string>();
  const rows = result.rows.map((raw) => {
    if (!isRecord(raw)) throw new StructuralOutputError('OCR verification response row is not an object');
    const articleId = text(raw.article_id);
    if (!expected.has(articleId) || seen.has(articleId)) throw new StructuralOutputError('OCR verification response contains unknown or duplicate article');
    seen.add(articleId);
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new StructuralOutputError('OCR verification confidence invalid');
    return { article_id: articleId, transcription: text(raw.transcription), confidence, proper_noun_status: text(raw.proper_noun_status), visual_proper_nouns: Array.isArray(raw.visual_proper_nouns) ? raw.visual_proper_nouns.map(text).filter(Boolean) : [], reason: text(raw.reason).slice(0, 1000) };
  });
  if (rows.length !== expected.size || seen.size !== expected.size) throw new StructuralOutputError('OCR verification response row_count mismatch');
  const chunkIndex = await nextChunkIndex(job.id, passKind);
  const { data, error } = await supabaseAdmin.rpc('append_ocr_verification_vision_chunk_v7', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_pass_kind: passKind,
    p_chunk_index: chunkIndex,
    p_model: model,
    p_provider_response_id: result.responseId,
    p_prompt_sha256: result.promptSha,
    p_response_sha256: result.responseSha,
    p_input_binding_sha256: inputBindingSha256,
    p_rows: rows
  });
  if (error) throw error;
  return data;
}

async function yieldJob(job: Job, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_ocr_verification_page_job_v2', { p_job_id: job.id, p_lease_token: job.lease_token, p_stage: stage });
  if (error) throw error;
  return data;
}
async function finalize(job: Job) {
  const { data, error } = await supabaseAdmin.rpc('finalize_ocr_verification_page_job_v2', { p_job_id: job.id, p_lease_token: job.lease_token });
  if (error) throw error;
  return data;
}
async function persistFailure(job: Job, errorValue: unknown) {
  const retryable = errorValue instanceof ProviderError ? errorValue.retryable : errorValue instanceof VisionProviderError ? errorValue.retryable : false;
  const { data, error } = await supabaseAdmin.rpc('fail_ocr_verification_page_job_v2', { p_job_id: job.id, p_lease_token: job.lease_token, p_error: errorMessage(errorValue), p_retryable: retryable });
  if (error) throw error;
  return data;
}

export async function getOcrVerificationStatus() {
  const [{ data: gate, error: gateError }, { data: jobs, error: jobsError }] = await Promise.all([
    supabaseAdmin.from('ocr_verification_gate_v2').select('*').maybeSingle(),
    supabaseAdmin.from('ocr_verification_page_jobs_v2').select('status,requires_second_pass')
  ]);
  if (gateError) throw gateError;
  if (jobsError) throw jobsError;
  const counts: Record<string, number> = {};
  for (const row of jobs || []) { const status = text(row.status) || 'unknown'; counts[status] = (counts[status] || 0) + 1; }
  return { gate, counts, second_pass_jobs: (jobs || []).filter((row) => row.requires_second_pass === true).length };
}

export async function ensureOcrVerificationJobs() {
  const { data, error } = await supabaseAdmin.rpc('enqueue_ocr_verification_page_jobs_v2');
  if (error) {
    const message = errorMessage(error);
    if (message.includes('source_region') || message.includes('inventory') || message.includes('freeze')) return { blocked: true as const, count: 0, reason: message };
    throw error;
  }
  return { blocked: false as const, count: Number(data || 0), reason: '' };
}

export async function runOcrVerificationWorkerStep() {
  const ensured = await ensureOcrVerificationJobs();
  if (ensured.blocked) return { claimed: 0, stage: 'blocked', reason: ensured.reason, external_calls: 0 };
  const job = await claimJob();
  if (!job) return { claimed: 0, stage: 'idle', enqueued: ensured.count, external_calls: 0 };
  let externalCalls = 0;
  try {
    const input = await loadInput(job);
    const cropRows = await existingCropRows(job.id);
    if (cropRows.size < job.article_count) {
      externalCalls = 1;
      const result = await runGoogleCropChunk(job, input);
      return { claimed: 1, job_id: job.id, stage: 'google_crop_ocr', result, yield: await yieldJob(job, 'google_crop_ocr'), external_calls: externalCalls };
    }
    const models = configuredModels();
    const verifierRows = await existingVisionArticleIds(job.id, 'verifier');
    if (verifierRows.size < job.article_count) {
      externalCalls = 1;
      const result = await runVisionChunk(job, input, 'verifier', models.verifier);
      return { claimed: 1, job_id: job.id, stage: 'vision_verifier', result, yield: await yieldJob(job, 'vision_verifier'), external_calls: externalCalls };
    }
    if (job.requires_second_pass) {
      const criticRows = await existingVisionArticleIds(job.id, 'critic');
      if (criticRows.size < job.article_count) {
        externalCalls = 1;
        const result = await runVisionChunk(job, input, 'critic', models.critic);
        return { claimed: 1, job_id: job.id, stage: 'vision_critic', result, yield: await yieldJob(job, 'vision_critic'), external_calls: externalCalls };
      }
    }
    return { claimed: 1, job_id: job.id, stage: 'finalize', result: await finalize(job), external_calls: 0 };
  } catch (error) {
    return { claimed: 1, job_id: job.id, stage: 'failed', error: errorMessage(error), result: await persistFailure(job, error), external_calls: externalCalls };
  }
}

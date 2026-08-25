import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { getOpenAIKey } from '@/lib/openai';
import { buildArticleBlockComposite, buildArticleReadingSegments, type ArticleBlockRect } from '@/lib/articleCrop';

type JsonRecord = Record<string, unknown>;
type PassKind = 'sol' | 'terra';
type Claim = { id: string; source_job_id: string; article_count: number; is_canary: boolean; lease_token: string };
type ArticleInput = {
  article_id: string;
  source_region_id: string;
  region_quality_status: string;
  crop_version: string;
  crop_spec_sha256: string;
  crop_image_sha256: string;
  google_text: string;
  google_text_sha256: string;
  source_mode: string;
  source_image_sha256: string;
  block_rects: ArticleBlockRect[];
};
type LoadedInput = {
  image: Buffer;
  width: number;
  height: number;
  mimeType: string;
  sourceImageSha256: string;
  articles: ArticleInput[];
};
type Composite = Awaited<ReturnType<typeof buildArticleBlockComposite>> & {
  article_id: string;
  article: ArticleInput;
  reading: Awaited<ReturnType<typeof buildArticleReadingSegments>>;
};

class StructuralOutputError extends Error {}
class ProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}

const LEASE_SECONDS = 360;
const CALL_TIMEOUT_MS = 150_000;
const VISION_CHUNK = 1;
const VISION_TEXT_BUDGET = 6000;

function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function normalizeToken(value: string) { return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return text(error.message || error.error || error.details || error);
  return text(error) || 'OCR consensus v11 worker failed';
}
function extractResponseText(responseJson: unknown) {
  const json = responseJson as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  return (json.output || []).flatMap((item) => item.content || []).map((item) => text(item.text)).filter(Boolean).join('\n').trim();
}
function configuredModels() {
  const sol = process.env.OPENAI_OCR_VERIFY_MODEL_V2?.trim() || 'gpt-5.6-sol';
  const terra = process.env.OPENAI_OCR_VERIFY_CRITIC_MODEL_V2?.trim() || 'gpt-5.6-terra';
  if (!sol || !terra || sol === terra) throw new StructuralOutputError('OCR consensus v11 requires two distinct models.');
  return { sol, terra };
}

async function claimJob(): Promise<Claim | null> {
  const { data, error } = await supabaseAdmin.rpc('claim_ocr_consensus_job_v11', { p_lease_seconds: LEASE_SECONDS });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const claim: Claim = {
    id: text(row.id), source_job_id: text(row.source_job_id), article_count: Number(row.article_count || 0),
    is_canary: row.is_canary === true, lease_token: text(row.lease_token)
  };
  if (!claim.id || !claim.source_job_id || !claim.lease_token || claim.article_count < 1) throw new StructuralOutputError('OCR consensus v11 claim is invalid.');
  return claim;
}

async function loadInput(claim: Claim): Promise<LoadedInput> {
  const { data, error } = await supabaseAdmin.rpc('get_ocr_consensus_page_input_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token });
  if (error) throw error;
  if (!isRecord(data) || !isRecord(data.source) || !Array.isArray(data.articles)) throw new StructuralOutputError('OCR consensus v11 input payload is invalid.');
  const source = data.source;
  const storagePath = text(source.storage_path);
  const width = Number(source.width || 0), height = Number(source.height || 0);
  if (!storagePath || width < 1 || height < 1) throw new StructuralOutputError('OCR consensus v11 source metadata is incomplete.');

  const articles = data.articles.map((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.block_rects)) throw new StructuralOutputError('OCR consensus v11 article input is invalid.');
    const article: ArticleInput = {
      article_id: text(raw.article_id), source_region_id: text(raw.source_region_id), region_quality_status: text(raw.region_quality_status),
      crop_version: text(raw.crop_version), crop_spec_sha256: text(raw.crop_spec_sha256), crop_image_sha256: text(raw.crop_image_sha256),
      google_text: text(raw.google_text), google_text_sha256: text(raw.google_text_sha256), source_mode: text(raw.source_mode), source_image_sha256: text(raw.source_image_sha256),
      block_rects: raw.block_rects.map((rect) => {
        if (!isRecord(rect)) throw new StructuralOutputError('OCR consensus v11 block rectangle is invalid.');
        return { block_index: Number(rect.block_index), x_min: Number(rect.x_min), y_min: Number(rect.y_min), x_max: Number(rect.x_max), y_max: Number(rect.y_max) };
      })
    };
    if (!article.article_id || article.crop_version !== 'article_geometry_mask_composite_v3' || !article.crop_spec_sha256 || !article.crop_image_sha256 || !article.google_text || !article.source_image_sha256 || !article.block_rects.length) {
      throw new StructuralOutputError(`OCR consensus v11 article binding is incomplete: ${article.article_id || 'unknown'}`);
    }
    return article;
  });
  if (articles.length !== claim.article_count || new Set(articles.map((item) => item.article_id)).size !== claim.article_count) throw new StructuralOutputError('OCR consensus v11 article set is not bijective.');

  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (downloaded.error) throw downloaded.error;
  if (!downloaded.data) throw new StructuralOutputError('OCR consensus v11 source download returned no data.');
  const image = Buffer.from(await downloaded.data.arrayBuffer());
  const sourceImageSha256 = sha256(image);
  for (const article of articles) {
    if (article.source_image_sha256 !== sourceImageSha256) throw new StructuralOutputError(`OCR consensus v11 source image binding changed: ${article.article_id}`);
  }
  return { image, width, height, mimeType: text(source.mime_type) || downloaded.data.type || 'image/jpeg', sourceImageSha256, articles };
}

async function buildComposites(input: LoadedInput, articles: ArticleInput[]) {
  const result: Composite[] = [];
  for (const article of articles) {
    const composite = await buildArticleBlockComposite({ imageBuffer: input.image, expectedWidth: input.width, expectedHeight: input.height, articleId: article.article_id, rects: article.block_rects });
    if (composite.cropSpecSha256 !== article.crop_spec_sha256 || composite.cropImageSha256 !== article.crop_image_sha256) {
      throw new StructuralOutputError(`OCR consensus v11 crop fingerprint changed: ${article.article_id}`);
    }
    const reading = await buildArticleReadingSegments({
      articleId: article.article_id,
      compositeBuffer: composite.buffer,
      compositeWidth: composite.width,
      compositeHeight: composite.height,
      compositeImageSha256: composite.cropImageSha256
    });
    if (!reading.segments.length) throw new StructuralOutputError(`OCR consensus v11 reading segmentation produced no segments: ${article.article_id}`);
    result.push({ ...composite, article_id: article.article_id, article, reading });
  }
  return result;
}

async function existingArticleIds(jobId: string, passKind: PassKind) {
  const { data, error } = await supabaseAdmin.from('ocr_independent_transcriptions_v11').select('article_id').eq('job_id', jobId).eq('pass_kind', passKind);
  if (error) throw error;
  return new Set((data || []).map((row) => text(row.article_id)).filter(Boolean));
}
async function existingDecisionIds(jobId: string) {
  const { data, error } = await supabaseAdmin.from('ocr_consensus_decisions_v11').select('article_id').eq('job_id', jobId);
  if (error) throw error;
  return new Set((data || []).map((row) => text(row.article_id)).filter(Boolean));
}
async function nextChunkIndex(jobId: string, passKind: PassKind) {
  const { data, error } = await supabaseAdmin.from('ocr_independent_pass_runs_v11').select('chunk_index').eq('job_id', jobId).eq('pass_kind', passKind).order('chunk_index', { ascending: false }).limit(1);
  if (error) throw error;
  return Array.isArray(data) && data[0] ? Number(data[0].chunk_index) + 1 : 0;
}

function chooseChunk(articles: ArticleInput[], existing: Set<string>, allowedIds?: Set<string>) {
  const selected: ArticleInput[] = [];
  let budget = 0;
  for (const article of articles) {
    if (existing.has(article.article_id) || (allowedIds && !allowedIds.has(article.article_id))) continue;
    const chars = article.google_text.length;
    if (chars <= 0) throw new StructuralOutputError(`OCR consensus v11 Google evidence text is empty: ${article.article_id}`);
    if (selected.length && (selected.length >= VISION_CHUNK || budget + chars > VISION_TEXT_BUDGET)) break;
    selected.push(article);
    budget += chars;
    if (selected.length >= VISION_CHUNK) break;
  }
  return selected;
}

function responseFormat(articleIds: string[]) {
  return {
    type: 'json_schema', name: 'mj_independent_article_ocr_v11', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['articles'],
      properties: {
        articles: {
          type: 'array', minItems: articleIds.length, maxItems: articleIds.length,
          items: {
            type: 'object', additionalProperties: false,
            required: ['article_id','transcription','confidence','proper_noun_status','visual_proper_nouns','reason'],
            properties: {
              article_id: { type: 'string', enum: articleIds },
              transcription: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              proper_noun_status: { type: 'string', enum: ['passed','not_applicable','failed'] },
              visual_proper_nouns: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' }
            }
          }
        }
      }
    }
  } as const;
}

async function callIndependentVision(input: { model: string; passKind: PassKind; crops: Composite[] }) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new StructuralOutputError('OPENAI_API_KEY is not configured.');
  const role = input.passKind === 'sol' ? 'primary independent OCR transcriber' : 'second independent OCR transcriber using a different model';
  const instructions = [
    `You are a ${role} for Japanese newspaper and magazine article images.`,
    'You are NOT given any candidate OCR. Transcribe only from the visible pixels in the supplied images.',
    'For each ARTICLE_ID, the first image is an OVERVIEW of the complete geometry-preserving article mask. Use the overview only to understand layout, headline placement, and how the following strips relate to the full article.',
    'After the overview, READING_SEGMENT images are supplied in explicit reading sequence. They are vertical strips cut at low-ink gutters and enlarged for legibility. For Japanese vertical body text, the segment sequence is rightmost to leftmost; within each segment read top-to-bottom.',
    'Use the enlarged READING_SEGMENT images as the primary transcription evidence. Do not duplicate text merely because it is also visible in the overview.',
    'White areas are intentionally excluded. Never infer text from excluded, clipped, blurred, or unreadable areas. Use the visible placeholder 〓 when characters are genuinely unreadable instead of inventing or paraphrasing text.',
    'Preserve visible characters, punctuation, decimals, percentages, dates, prices, quantities, company names, product names, and personal names exactly as read. Never silently normalize, repair, summarize, or rewrite a token.',
    'Do not interleave separate columns. Join the ordered segments into one transcription using line breaks where the article visibly changes paragraph, column, headline, caption, or section.',
    'confidence is the confidence that YOUR transcription is materially faithful to the visible pixels. Lower it for unreadable, clipped, overlapping, uncertain, or layout-ambiguous text.',
    'visual_proper_nouns must contain only proper nouns copied verbatim from your own transcription that you can visibly confirm. If none are present, use not_applicable and an empty array. If an important proper noun is visible but unreadable, use failed.',
    'Return exactly one row for each supplied article_id and no others.'
  ].join('\n');
  const content: Array<Record<string, unknown>> = [{
    type: 'input_text',
    text: JSON.stringify({
      task: 'independent_visual_ocr_v11_segmented',
      pass_kind: input.passKind,
      articles: input.crops.map((crop) => ({
        article_id: crop.article_id,
        crop_image_sha256: crop.cropImageSha256,
        reading_order: crop.reading.readingOrder,
        segmentation_version: crop.reading.version,
        segmentation_spec_sha256: crop.reading.segmentationSpecSha256,
        segment_count: crop.reading.segments.length
      }))
    })
  }];
  for (const crop of input.crops) {
    content.push({ type: 'input_text', text: `ARTICLE_ID=${crop.article_id} IMAGE=OVERVIEW` });
    content.push({ type: 'input_image', image_url: `data:${crop.mimeType};base64,${crop.buffer.toString('base64')}`, detail: 'high' });
    for (const segment of crop.reading.segments) {
      content.push({
        type: 'input_text',
        text: `ARTICLE_ID=${crop.article_id} READING_SEGMENT=${segment.sequence}/${crop.reading.segments.length} ORDER=${crop.reading.readingOrder} BOUNDS=${segment.left},${segment.top},${segment.right},${segment.bottom}`
      });
      content.push({ type: 'input_image', image_url: `data:${segment.mimeType};base64,${segment.buffer.toString('base64')}`, detail: 'high' });
    }
  }
  const promptSha = sha256([
    input.model,
    input.passKind,
    instructions,
    ...input.crops.map((crop) => `${crop.article_id}:${crop.cropImageSha256}:${crop.reading.segmentationSpecSha256}:${crop.reading.segments.map((segment) => segment.imageSha256).join(',')}`)
  ].join('\n---\n'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ model: input.model, store: false, max_output_tokens: 16000, instructions, input: [{ role: 'user', content }], text: { format: responseFormat(input.crops.map((crop) => crop.article_id)) } })
    });
    const raw = await response.text();
    if (!response.ok) throw new ProviderError(`OpenAI independent OCR v11 failed: ${response.status} ${response.statusText} ${raw.slice(0, 1800)}`, response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500);
    let json: JsonRecord;
    try { json = JSON.parse(raw) as JsonRecord; } catch { throw new ProviderError('OpenAI independent OCR v11 response JSON is malformed.', true); }
    const responseId = text(json.id), output = extractResponseText(json);
    if (!responseId || !output) throw new ProviderError('OpenAI independent OCR v11 response receipt or output is missing.', true);
    let parsed: JsonRecord;
    try { parsed = JSON.parse(output) as JsonRecord; } catch { throw new StructuralOutputError('OpenAI independent OCR v11 structured output is invalid JSON.'); }
    if (!Array.isArray(parsed.articles)) throw new StructuralOutputError('OpenAI independent OCR v11 articles array is missing.');
    return { rows: parsed.articles, responseId, promptSha, responseSha: sha256(raw) };
  } catch (error) {
    if (error instanceof ProviderError || error instanceof StructuralOutputError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new ProviderError('OpenAI independent OCR v11 request timed out.', true);
    if (error instanceof TypeError) throw new ProviderError(`OpenAI independent OCR v11 network failure: ${error.message}`, true);
    throw error;
  } finally { clearTimeout(timer); }
}

function inputBinding(crops: Composite[]) {
  const values = crops.map((crop) => `${crop.article_id}:${crop.article.crop_spec_sha256}:${crop.article.crop_image_sha256}:${crop.article.source_mode}:${crop.article.source_image_sha256}`).sort();
  return sha256(values.join('|'));
}

function sanitizeRows(rows: unknown[], crops: Composite[]) {
  const expected = new Set(crops.map((crop) => crop.article_id));
  const seen = new Set<string>();
  return rows.map((raw) => {
    if (!isRecord(raw)) throw new StructuralOutputError('OpenAI independent OCR v11 row is not an object.');
    const articleId = text(raw.article_id);
    if (!expected.has(articleId) || seen.has(articleId)) throw new ProviderError('OpenAI independent OCR v11 contains unknown or duplicate article.', true);
    seen.add(articleId);
    const transcription = text(raw.transcription);
    if (!transcription) throw new StructuralOutputError(`OpenAI independent OCR v11 transcription is empty: ${articleId}`);
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new StructuralOutputError(`OpenAI independent OCR v11 confidence is invalid: ${articleId}`);
    let properNounStatus = text(raw.proper_noun_status);
    const nouns = Array.isArray(raw.visual_proper_nouns) ? raw.visual_proper_nouns.map(text).filter(Boolean) : [];
    let contractStatus = 'passed';
    let reason = text(raw.reason).slice(0, 1400);
    const normalizedTranscription = normalizeToken(transcription);
    const nounContractBroken =
      !['passed','not_applicable','failed'].includes(properNounStatus)
      || (properNounStatus === 'passed' && nouns.length === 0)
      || (properNounStatus === 'not_applicable' && nouns.length > 0)
      || nouns.some((noun) => !normalizeToken(noun) || !normalizedTranscription.includes(normalizeToken(noun)));
    if (nounContractBroken) {
      contractStatus = 'failed';
      properNounStatus = 'failed';
      reason = `[model_output_contract_violation] ${reason}`.slice(0, 1500);
    }
    return { article_id: articleId, transcription, confidence, proper_noun_status: properNounStatus, visual_proper_nouns: nouns, output_contract_status: contractStatus, reason };
  });
}

async function runPassChunk(claim: Claim, input: LoadedInput, passKind: PassKind, model: string, allowedIds?: Set<string>) {
  const existing = await existingArticleIds(claim.id, passKind);
  const selected = chooseChunk(input.articles, existing, allowedIds);
  if (!selected.length) return { complete: true, stored: 0 };
  const crops = await buildComposites(input, selected);
  const result = await callIndependentVision({ model, passKind, crops });
  const rows = sanitizeRows(result.rows, crops);
  if (rows.length !== crops.length) throw new ProviderError('OpenAI independent OCR v11 row count mismatch.', true);
  const chunkIndex = await nextChunkIndex(claim.id, passKind);
  const binding = inputBinding(crops);
  const { data, error } = await supabaseAdmin.rpc('append_ocr_independent_pass_v11', {
    p_job_id: claim.id, p_lease_token: claim.lease_token, p_pass_kind: passKind, p_chunk_index: chunkIndex, p_model: model,
    p_provider_response_id: result.responseId, p_prompt_sha256: result.promptSha, p_response_sha256: result.responseSha,
    p_input_binding_sha256: binding, p_rows: rows
  });
  if (error) throw error;
  return data;
}

async function evaluateUndecided(claim: Claim, input: LoadedInput) {
  const decided = await existingDecisionIds(claim.id);
  const terraRequired = new Set<string>();
  for (const article of input.articles) {
    if (decided.has(article.article_id)) continue;
    const { data, error } = await supabaseAdmin.rpc('decide_ocr_consensus_article_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token, p_article_id: article.article_id });
    if (error) throw error;
    const status = text(isRecord(data) ? data.status : '');
    if (status === 'terra_required') terraRequired.add(article.article_id);
    else if (!['passed_single','passed_two_model','needs_review','sol_required'].includes(status)) throw new StructuralOutputError(`OCR consensus v11 decision state is invalid: ${status || 'empty'}`);
  }
  return terraRequired;
}

async function yieldJob(claim: Claim, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_ocr_consensus_job_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token, p_stage: stage });
  if (error) throw error;
  return data;
}
async function finishJob(claim: Claim) {
  const { data, error } = await supabaseAdmin.rpc('finish_ocr_consensus_job_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token });
  if (error) throw error;
  return data;
}
async function failJob(claim: Claim, errorValue: unknown) {
  const retryable = errorValue instanceof ProviderError ? errorValue.retryable : false;
  const { data, error } = await supabaseAdmin.rpc('fail_ocr_consensus_job_v11', { p_job_id: claim.id, p_lease_token: claim.lease_token, p_error: errorMessage(errorValue), p_retryable: retryable });
  if (error) throw error;
  return data;
}

export async function getOcrConsensusV11Status() {
  const { data, error } = await supabaseAdmin.from('ocr_consensus_jobs_v11').select('status,is_canary,article_count');
  if (error) throw error;
  const counts: Record<string, number> = {};
  let articles = 0;
  for (const row of data || []) { const status = text(row.status) || 'unknown'; counts[status] = (counts[status] || 0) + 1; articles += Number(row.article_count || 0); }
  return { counts, jobs: (data || []).length, articles, canary_jobs: (data || []).filter((row) => row.is_canary === true).length };
}

export async function runOcrConsensusV11Step() {
  const claim = await claimJob();
  if (!claim) return { claimed: 0, stage: 'idle', external_calls: 0 };
  let externalCalls = 0;
  try {
    const input = await loadInput(claim);
    const models = configuredModels();

    const solExisting = await existingArticleIds(claim.id, 'sol');
    if (solExisting.size < claim.article_count) {
      externalCalls = 1;
      const result = await runPassChunk(claim, input, 'sol', models.sol);
      return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: 'sol', result, yield: await yieldJob(claim, 'sol'), external_calls: externalCalls };
    }

    let terraRequired = await evaluateUndecided(claim, input);
    if (terraRequired.size) {
      const terraExisting = await existingArticleIds(claim.id, 'terra');
      const terraMissing = new Set([...terraRequired].filter((articleId) => !terraExisting.has(articleId)));
      if (terraMissing.size) {
        externalCalls = 1;
        const result = await runPassChunk(claim, input, 'terra', models.terra, terraMissing);
        return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: 'terra', result, yield: await yieldJob(claim, 'terra'), external_calls: externalCalls };
      }
      terraRequired = await evaluateUndecided(claim, input);
      if (terraRequired.size) throw new StructuralOutputError(`OCR consensus v11 still requires Terra after Terra completion: ${[...terraRequired].join(',')}`);
    }

    const decided = await existingDecisionIds(claim.id);
    if (decided.size !== claim.article_count) throw new StructuralOutputError(`OCR consensus v11 decisions incomplete: ${decided.size}/${claim.article_count}`);
    return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: 'finalize', result: await finishJob(claim), external_calls: 0 };
  } catch (error) {
    return { claimed: 1, job_id: claim.id, source_job_id: claim.source_job_id, stage: 'failed', error: errorMessage(error), result: await failJob(claim, error), external_calls: externalCalls };
  }
}

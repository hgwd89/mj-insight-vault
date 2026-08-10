import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from './supabaseAdmin';
import { getOpenAIKey, VISION_MODEL } from './openai';
import { runArticleInventoryWorkerV5ConsensusStep } from './articleInventoryWorkerV5Consensus';

type JsonRecord = Record<string, unknown>;
type PassKind = 'mapper' | 'critic' | 'adjudicator';
type ClaimedJob = {
  id: string;
  inventory_source_image_id: string;
  source_ocr_json_sha256: string;
  block_count: number;
  requires_third_pass: boolean;
  lease_token: string;
};
type OcrBlock = {
  block_index: number;
  block_text: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  source_ocr_json_sha256: string;
};
type SourceImage = { buffer: Buffer; mimeType: string; width: number; height: number };
type Region = { x_min: number; y_min: number; x_max: number; y_max: number };
type VisionArticle = { headline_hint: string; confidence: number; regions: Region[]; reason: string };
type InventoryGroup = {
  group_kind: 'article' | 'non_article';
  block_indices: number[];
  headline_anchor: string;
  non_article_role: string;
  confidence: number;
  reason: string;
};
type Receipt = { parsed: JsonRecord; providerResponseId: string; promptSha256: string; responseSha256: string };
type RegionEvidence = {
  article_seq: number;
  headline_hint: string;
  confidence: number;
  regions: Region[];
  reason: string;
  grounded_block_count: number;
  ambiguous_block_count: number;
  dropped_from_partition: boolean;
};
type StoredRegionEvidence = {
  pass_kind: PassKind;
  headline_hint: string;
  regions: unknown;
  dropped_from_partition: boolean;
};

class ReviewRequiredError extends Error {}

const COORD_MAX = 1000;
const CENTER_MARGIN = 6;
const RAW_MIN_CONFIDENCE = 0.60;

const visionSchema = {
  type: 'json_schema',
  name: 'mj_visual_article_regions_v6_grounded',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['articles'],
    properties: {
      articles: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['headline_hint', 'confidence', 'regions', 'reason'],
          properties: {
            headline_hint: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
            regions: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['x_min', 'y_min', 'x_max', 'y_max'],
                properties: {
                  x_min: { type: 'integer', minimum: 0, maximum: 1000 },
                  y_min: { type: 'integer', minimum: 0, maximum: 1000 },
                  x_max: { type: 'integer', minimum: 0, maximum: 1000 },
                  y_max: { type: 'integer', minimum: 0, maximum: 1000 }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

function text(value: unknown) { return value == null ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewRequiredError('Expected object response.');
  return value as JsonRecord;
}
function outputText(payload: JsonRecord) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  for (const rawItem of Array.isArray(payload.output) ? payload.output : []) {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as JsonRecord : {};
    for (const rawPart of Array.isArray(item.content) ? item.content : []) {
      const part = rawPart && typeof rawPart === 'object' ? rawPart as JsonRecord : {};
      if (typeof part.text === 'string' && part.text.trim()) return part.text.trim();
    }
  }
  throw new ReviewRequiredError('OpenAI response missing output text.');
}
function normalizeText(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function bigrams(value: string) {
  const normalized = normalizeText(value); const out = new Set<string>();
  if (normalized.length === 1) out.add(normalized);
  for (let i = 0; i < normalized.length - 1; i += 1) out.add(normalized.slice(i, i + 2));
  return out;
}
function textSimilarity(a: string, b: string) {
  const aa = bigrams(a), bb = bigrams(b); if (!aa.size || !bb.size) return 0;
  let hit = 0; for (const x of aa) if (bb.has(x)) hit += 1;
  return 2 * hit / (aa.size + bb.size);
}
function requireDistinctModels(models: string[], label: string) {
  if (new Set(models).size !== models.length) throw new ReviewRequiredError(`${label}: distinct models required`);
}

async function claim(jobId?: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_v3', {
    p_job_id: jobId || null,
    p_lease_seconds: 300
  });
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data[0] : data) || null) as ClaimedJob | null;
}
async function yieldJob(job: ClaimedJob, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_source_page_article_inventory_job_v2', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_stage: stage
  });
  if (error) throw new Error(error.message); return data;
}
async function reviewJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason.slice(0, 3000)
  });
  if (error) throw new Error(`${reason}; review rpc: ${error.message}`); return data;
}
async function failJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_error_message: reason.slice(0, 3000), p_retryable: true
  });
  if (error) throw new Error(`${reason}; fail rpc: ${error.message}`); return data;
}
async function passKinds(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_pass_runs_v1').select('pass_kind').eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((row) => String(row.pass_kind)));
}
async function loadBlocks(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,source_ocr_json_sha256').eq('job_id', job.id).order('block_index');
  if (error) throw new Error(error.message);
  const blocks = (data || []) as OcrBlock[];
  if (blocks.length !== job.block_count || blocks.some((b) => b.source_ocr_json_sha256 !== job.source_ocr_json_sha256)) {
    throw new ReviewRequiredError('Fresh OCR block provenance drift.');
  }
  return blocks;
}
async function loadSource(job: ClaimedJob): Promise<SourceImage> {
  const { data, error } = await supabaseAdmin.from('source_images')
    .select('storage_path,mime_type,width,height,storage_size_bytes').eq('id', job.inventory_source_image_id).single();
  if (error) throw new Error(error.message);
  const width = Number(data.width || 0), height = Number(data.height || 0), expectedSize = Number(data.storage_size_bytes || 0);
  if (!data.storage_path || width < 1 || height < 1) throw new ReviewRequiredError('Source image metadata incomplete.');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(String(data.storage_path));
  if (downloaded.error || !downloaded.data) throw new Error(downloaded.error?.message || 'Image download failed.');
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (expectedSize > 0 && buffer.length !== expectedSize) throw new ReviewRequiredError('Source image size drift.');
  return { buffer, width, height, mimeType: String(data.mime_type || downloaded.data.type || 'image/jpeg') };
}

function visionInstructions(passKind: PassKind) {
  return [
    'You are an independent blind newspaper page-layout auditor.',
    'Use only the supplied page image. Do not use database article counts, filenames, prior OCR grouping, or prior pass outputs.',
    'Identify every distinct standalone editorial article visible on the page.',
    'Do not count advertisements, promotional panels, mastheads, folios, navigation, subscription notices, decorative text, isolated captions, or charts without a standalone editorial article.',
    'A subsection or subheading inside one article is not a separate article.',
    'If one article occupies several separated columns or non-rectangular areas, return multiple tight rectangles for the same article.',
    'Each rectangle uses normalized page coordinates from 0 to 1000.',
    'Rectangles must be tight around that article and must avoid neighboring articles and advertisements.',
    'headline_hint is a short visual transcription of the article headline.',
    'Use confidence below 0.80 when the boundary is genuinely uncertain rather than forcing certainty.',
    `This is independent visual pass ${passKind}.`,
    'Return only JSON matching the schema.'
  ].join(' ');
}
async function callVision(model: string, passKind: PassKind, source: SourceImage): Promise<Receipt> {
  const apiKey = getOpenAIKey(); if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const body = {
    model,
    store: false,
    max_output_tokens: 6000,
    instructions: visionInstructions(passKind),
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'Audit this newspaper page visually. Return standalone editorial article regions only. Coordinates are normalized to 1000 x 1000.' },
      { type: 'input_image', image_url: `data:${source.mimeType};base64,${source.buffer.toString('base64')}`, detail: 'high' }
    ] }],
    text: { format: visionSchema }
  };
  const promptSha256 = sha256(JSON.stringify(body));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const payload = JSON.parse(raw) as JsonRecord; const providerResponseId = text(payload.id);
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('Invalid provider response receipt.');
  let parsed: JsonRecord;
  try { parsed = JSON.parse(outputText(payload)) as JsonRecord; } catch { throw new ReviewRequiredError('Visual region response is not valid JSON.'); }
  return { parsed, providerResponseId, promptSha256, responseSha256: sha256(raw) };
}
function parseVisionArticles(parsed: JsonRecord) {
  if (!Array.isArray(parsed.articles) || parsed.articles.length < 1 || parsed.articles.length > 12) throw new ReviewRequiredError('Visual pass returned invalid article count.');
  return parsed.articles.map((raw, articleIndex) => {
    const item = record(raw); const headlineHint = text(item.headline_hint); const confidence = Number(item.confidence); const reason = text(item.reason);
    if (headlineHint.length < 2 || !Number.isFinite(confidence) || confidence < RAW_MIN_CONFIDENCE || confidence > 1 || reason.length < 2) {
      throw new ReviewRequiredError(`Visual article ${articleIndex} has invalid hint/confidence/reason.`);
    }
    if (!Array.isArray(item.regions) || item.regions.length < 1 || item.regions.length > 8) throw new ReviewRequiredError(`Visual article ${articleIndex} regions invalid.`);
    const regions = item.regions.map((rawRegion, regionIndex) => {
      const r = record(rawRegion);
      const rawValue = { x_min: Number(r.x_min), y_min: Number(r.y_min), x_max: Number(r.x_max), y_max: Number(r.y_max) };
      if (!Object.values(rawValue).every(Number.isInteger) || rawValue.x_min < 0 || rawValue.y_min < 0 || rawValue.x_max > 1000 || rawValue.y_max > 1000) {
        throw new ReviewRequiredError(`Visual article ${articleIndex} region ${regionIndex} invalid.`);
      }
      let xMin = Math.min(rawValue.x_min, rawValue.x_max);
      let xMax = Math.max(rawValue.x_min, rawValue.x_max);
      let yMin = Math.min(rawValue.y_min, rawValue.y_max);
      let yMax = Math.max(rawValue.y_min, rawValue.y_max);
      if (xMax === xMin) { if (xMax < 1000) xMax += 1; else xMin -= 1; }
      if (yMax === yMin) { if (yMax < 1000) yMax += 1; else yMin -= 1; }
      return { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax };
    });
    return { headline_hint: headlineHint, confidence, reason, regions } as VisionArticle;
  });
}
function normalizedBlockRect(block: OcrBlock, source: SourceImage): Region {
  return { x_min: block.x_min / source.width * COORD_MAX, y_min: block.y_min / source.height * COORD_MAX, x_max: block.x_max / source.width * COORD_MAX, y_max: block.y_max / source.height * COORD_MAX };
}
function area(r: Region) { return Math.max(1e-6, (r.x_max - r.x_min) * (r.y_max - r.y_min)); }
function intersectionArea(a: Region, b: Region) { return Math.max(0, Math.min(a.x_max, b.x_max) - Math.max(a.x_min, b.x_min)) * Math.max(0, Math.min(a.y_max, b.y_max) - Math.max(a.y_min, b.y_min)); }
function articleScore(block: Region, article: VisionArticle) {
  const cx = (block.x_min + block.x_max) / 2, cy = (block.y_min + block.y_max) / 2; let best = 0;
  for (const region of article.regions) {
    const coverage = intersectionArea(block, region) / area(block);
    const inside = cx >= Math.max(0, region.x_min - CENTER_MARGIN) && cx <= Math.min(1000, region.x_max + CENTER_MARGIN) && cy >= Math.max(0, region.y_min - CENTER_MARGIN) && cy <= Math.min(1000, region.y_max + CENTER_MARGIN);
    best = Math.max(best, inside ? 1 + coverage : coverage >= 0.35 ? coverage : 0);
  }
  return best;
}
function chooseAnchor(article: VisionArticle, blocks: OcrBlock[]) {
  const usable = blocks.filter((b) => b.block_text.trim().length >= 2); if (!usable.length) throw new ReviewRequiredError('Grounded article has no usable anchor block.');
  const maxHeight = Math.max(...usable.map((b) => Math.max(1, b.y_max - b.y_min))); let best = usable[0], bestScore = -1;
  for (const block of usable) {
    const score = 0.82 * textSimilarity(article.headline_hint, block.block_text) + 0.18 * Math.min(1, Math.max(1, block.y_max - block.y_min) / maxHeight);
    if (score > bestScore) { bestScore = score; best = block; }
  }
  const raw = best.block_text.trim(); return raw.length <= 100 ? raw : raw.slice(0, 100).trim();
}
function deriveGroundedGroups(articles: VisionArticle[], blocks: OcrBlock[], source: SourceImage, passKind: PassKind) {
  const assigned = new Map<number, number[]>(); const ambiguousByArticle = new Map<number, number>(); const leftovers: number[] = [];
  for (const block of blocks) {
    const rect = normalizedBlockRect(block, source);
    const scores = articles.map((article, index) => ({ index, score: articleScore(rect, article) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    if (!scores.length) { leftovers.push(block.block_index); continue; }
    const winner = scores[0].index; const list = assigned.get(winner) || []; list.push(block.block_index); assigned.set(winner, list);
    if (scores.length > 1 && scores[0].score - scores[1].score < 0.08) ambiguousByArticle.set(winner, (ambiguousByArticle.get(winner) || 0) + 1);
  }
  const byIndex = new Map(blocks.map((b) => [b.block_index, b])); const groups: InventoryGroup[] = []; const evidence: RegionEvidence[] = [];
  let dropped = 0;
  articles.forEach((article, index) => {
    const ids = (assigned.get(index) || []).sort((a, b) => a - b); const ambiguous = ambiguousByArticle.get(index) || 0; const droppedHere = ids.length === 0;
    if (droppedHere) dropped += 1;
    evidence.push({ article_seq: index + 1, headline_hint: article.headline_hint, confidence: article.confidence, regions: article.regions, reason: article.reason, grounded_block_count: ids.length, ambiguous_block_count: ambiguous, dropped_from_partition: droppedHere });
    if (droppedHere) return;
    const articleBlocks = ids.map((id) => byIndex.get(id)).filter(Boolean) as OcrBlock[];
    groups.push({ group_kind: 'article', block_indices: ids, headline_anchor: chooseAnchor(article, articleBlocks), non_article_role: '', confidence: article.confidence,
      reason: `visual_regions_v6 pass=${passKind}; raw_article_seq=${index + 1}; hint=${article.headline_hint}; regions=${JSON.stringify(article.regions)}; ambiguous_winner_blocks=${ambiguous}; dropped_visual_regions=${dropped}; ${article.reason}` });
  });
  if (leftovers.length) groups.push({ group_kind: 'non_article', block_indices: leftovers.sort((a, b) => a - b), headline_anchor: '', non_article_role: 'outside_all_grounded_visual_article_regions', confidence: 0.99,
    reason: `deterministic complement of grounded visual regions for pass ${passKind}; dropped_zero_block_regions=${dropped}` });
  if (!groups.length) throw new ReviewRequiredError('No grounded OCR partition could be derived from visual regions.');
  const seen = new Set<number>();
  for (const group of groups) for (const id of group.block_indices) { if (seen.has(id)) throw new ReviewRequiredError(`Grounded partition duplicates block ${id}.`); seen.add(id); }
  if (seen.size !== blocks.length) throw new ReviewRequiredError(`Grounded partition incomplete ${seen.size}/${blocks.length}.`);
  return { groups: groups.sort((a, b) => Math.min(...a.block_indices) - Math.min(...b.block_indices)), evidence };
}
async function persistRegionEvidence(job: ClaimedJob, passKind: PassKind, model: string, receipt: Receipt, evidence: RegionEvidence[]) {
  const rows = evidence.map((e) => ({ job_id: job.id, pass_kind: passKind, article_seq: e.article_seq, headline_hint: e.headline_hint, confidence: e.confidence, regions: e.regions, reason: e.reason,
    grounded_block_count: e.grounded_block_count, ambiguous_block_count: e.ambiguous_block_count, dropped_from_partition: e.dropped_from_partition, model,
    provider_response_id: receipt.providerResponseId, prompt_sha256: receipt.promptSha256, response_sha256: receipt.responseSha256, recorded_at: new Date().toISOString() }));
  const { error } = await supabaseAdmin.from('source_page_inventory_visual_region_evidence_v6').upsert(rows, { onConflict: 'job_id,pass_kind,article_seq' });
  if (error) throw new Error(error.message);
}
async function persistPass(job: ClaimedJob, passKind: PassKind, model: string, receipt: Receipt, groups: InventoryGroup[]) {
  const { data, error } = await supabaseAdmin.rpc('record_source_page_article_inventory_pass_v3', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_pass_kind: passKind, p_model: model, p_provider_response_id: receipt.providerResponseId,
    p_prompt_sha256: receipt.promptSha256, p_response_sha256: receipt.responseSha256, p_groups: groups
  });
  if (error) throw new Error(error.message); return data;
}
async function runRawVisualPass(job: ClaimedJob, blocks: OcrBlock[], passKind: PassKind, model: string) {
  const source = await loadSource(job); const receipt = await callVision(model, passKind, source); const articles = parseVisionArticles(receipt.parsed);
  const derived = deriveGroundedGroups(articles, blocks, source, passKind); await persistRegionEvidence(job, passKind, model, receipt, derived.evidence);
  const stored = await persistPass(job, passKind, model, receipt, derived.groups);
  return { raw_article_regions: articles.length, grounded_article_groups: derived.groups.filter((g) => g.group_kind === 'article').length,
    dropped_zero_block_regions: derived.evidence.filter((e) => e.dropped_from_partition).length, ambiguous_blocks: derived.evidence.reduce((n, e) => n + e.ambiguous_block_count, 0), stored };
}
function bbox(regions: unknown): Region | null {
  if (!Array.isArray(regions) || !regions.length) return null; const parsed = regions.map((x) => record(x));
  const values = parsed.map((r) => ({ x_min: Number(r.x_min), y_min: Number(r.y_min), x_max: Number(r.x_max), y_max: Number(r.y_max) }));
  if (values.some((r) => !Object.values(r).every(Number.isFinite))) return null;
  return { x_min: Math.min(...values.map((r) => r.x_min)), y_min: Math.min(...values.map((r) => r.y_min)), x_max: Math.max(...values.map((r) => r.x_max)), y_max: Math.max(...values.map((r) => r.y_max)) };
}
function iou(a: Region, b: Region) { const inter = intersectionArea(a, b); return inter / Math.max(1e-6, area(a) + area(b) - inter); }
async function checkSupportedUngroundedRegions(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_inventory_visual_region_evidence_v6').select('pass_kind,headline_hint,regions,dropped_from_partition').eq('job_id', jobId).eq('dropped_from_partition', true);
  if (error) throw new Error(error.message); const rows = (data || []) as StoredRegionEvidence[];
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    if (rows[i].pass_kind === rows[j].pass_kind) continue; const a = bbox(rows[i].regions), b = bbox(rows[j].regions); if (!a || !b) continue;
    const overlap = iou(a, b), hint = textSimilarity(rows[i].headline_hint, rows[j].headline_hint);
    if ((overlap >= 0.25 && hint >= 0.10) || overlap >= 0.50 || hint >= 0.65) {
      throw new ReviewRequiredError(`Two independent visual passes support an article region with zero fresh OCR blocks; pass=${rows[i].pass_kind}/${rows[j].pass_kind}; iou=${overlap.toFixed(3)}; hint_similarity=${hint.toFixed(3)}. Requires region-level OCR recovery.`);
    }
  }
}

export async function runArticleInventoryWorkerV6GroundedStep(jobId?: string) {
  const job = await claim(jobId); if (!job) return { claimed: 0, job_id: jobId || null, worker_version: 'article_inventory_v6_grounded_visual_consensus' };
  try {
    const mapperModel = process.env.OPENAI_INVENTORY_MAPPER_MODEL || VISION_MODEL;
    const criticModel = process.env.OPENAI_INVENTORY_CRITIC_MODEL || 'gpt-4o';
    const adjudicatorModel = process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL || 'gpt-4o-mini';
    requireDistinctModels([mapperModel, criticModel, adjudicatorModel], 'grounded visual inventory');
    const blocks = await loadBlocks(job); const existing = await passKinds(job.id);
    if (!existing.has('mapper')) {
      const result = await runRawVisualPass(job, blocks, 'mapper', mapperModel);
      return { claimed: 1, job_id: job.id, stage: 'visual_mapper_v6_grounded', result, yield: await yieldJob(job, 'visual_mapper_v6_grounded') };
    }
    if (!existing.has('critic')) {
      const result = await runRawVisualPass(job, blocks, 'critic', criticModel);
      return { claimed: 1, job_id: job.id, stage: 'visual_critic_v6_grounded', result, yield: await yieldJob(job, 'visual_critic_v6_grounded') };
    }
    await checkSupportedUngroundedRegions(job.id);
    if (job.requires_third_pass && !existing.has('adjudicator')) {
      const result = await runRawVisualPass(job, blocks, 'adjudicator', adjudicatorModel);
      return { claimed: 1, job_id: job.id, stage: 'visual_adjudicator_v6_grounded', result, yield: await yieldJob(job, 'visual_adjudicator_v6_grounded') };
    }
    await checkSupportedUngroundedRegions(job.id);
    const released = await yieldJob(job, 'visual_raw_passes_v6_ready');
    return { claimed: 1, job_id: job.id, stage: 'visual_delegate_v6_to_consensus', released, delegated: await runArticleInventoryWorkerV5ConsensusStep(job.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'grounded visual inventory v6 error';
    if (error instanceof ReviewRequiredError) return { claimed: 1, job_id: job.id, stage: 'visual_review_required_v6', error: message, result: await reviewJob(job, message) };
    return { claimed: 1, job_id: job.id, stage: 'visual_failed_v6', error: message, result: await failJob(job, message) };
  }
}

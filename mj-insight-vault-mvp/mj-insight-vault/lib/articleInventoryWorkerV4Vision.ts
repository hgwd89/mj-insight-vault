import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from './supabaseAdmin';
import { getOpenAIKey, VISION_MODEL } from './openai';
import { runArticleInventoryWorkerV3Step } from './articleInventoryWorkerV3';

type JsonRecord = Record<string, unknown>;
type PassKind = 'mapper' | 'critic' | 'adjudicator';

type ClaimedJob = {
  id: string;
  page_identity_source_image_id: string;
  inventory_source_image_id: string;
  source_ocr_json_sha256: string;
  block_count: number;
  existing_article_count: number;
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
  ocr_confidence: number;
  source_ocr_json_sha256: string;
};

type SourceImage = {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
};

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

type Receipt = {
  parsed: JsonRecord;
  providerResponseId: string;
  promptSha256: string;
  responseSha256: string;
};

class ReviewRequiredError extends Error {}

const LEASE_SECONDS = 240;
const COORD_MAX = 1000;
const CENTER_MARGIN = 6;

const visionSchema = {
  type: 'json_schema',
  name: 'mj_visual_article_regions_v4',
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

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object response.');
  return value as JsonRecord;
}

function text(value: unknown) {
  return value == null ? '' : String(value).trim();
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
  throw new Error('OpenAI response missing output text.');
}

function requireDistinctModels(models: string[], label: string) {
  if (new Set(models).size !== models.length) throw new ReviewRequiredError(`${label}: distinct models required`);
}

async function claim(jobId?: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_v3', {
    p_job_id: jobId || null,
    p_lease_seconds: LEASE_SECONDS
  });
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data[0] : data) || null) as ClaimedJob | null;
}

async function loadBlocks(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256')
    .eq('job_id', job.id)
    .order('block_index', { ascending: true });
  if (error) throw new Error(error.message);
  const blocks = (data || []) as OcrBlock[];
  if (blocks.length !== job.block_count) throw new ReviewRequiredError(`block count drift: ${blocks.length} != ${job.block_count}`);
  if (blocks.some((block) => block.source_ocr_json_sha256 !== job.source_ocr_json_sha256)) throw new ReviewRequiredError('OCR provenance drift.');
  return blocks;
}

async function loadSource(job: ClaimedJob): Promise<SourceImage> {
  const { data, error } = await supabaseAdmin
    .from('source_images')
    .select('storage_path,mime_type,width,height,storage_size_bytes')
    .eq('id', job.inventory_source_image_id)
    .single();
  if (error) throw new Error(error.message);
  const width = Number(data.width || 0);
  const height = Number(data.height || 0);
  const expectedSize = Number(data.storage_size_bytes || 0);
  const storagePath = String(data.storage_path || '');
  if (!storagePath || width < 1 || height < 1) throw new ReviewRequiredError('source image metadata incomplete');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
  if (downloaded.error) throw new Error(downloaded.error.message);
  if (!downloaded.data) throw new Error('source image download returned no data');
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (expectedSize > 0 && buffer.length !== expectedSize) throw new ReviewRequiredError(`source binary size mismatch: ${buffer.length} != ${expectedSize}`);
  return {
    buffer,
    width,
    height,
    mimeType: String(data.mime_type || downloaded.data.type || 'image/jpeg')
  };
}

async function passKinds(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_pass_runs_v1')
    .select('pass_kind')
    .eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((row) => String(row.pass_kind)));
}

function visionInstructions(passKind: PassKind) {
  return [
    'You are an independent blind newspaper page-layout auditor.',
    'Use only the supplied page image. Do not use database article counts, filenames, prior OCR grouping, or prior pass outputs.',
    'Identify every distinct standalone editorial article visible on the page.',
    'Do not count advertisements, advertorial-looking promotional panels, mastheads, folios, navigation, subscription notices, decorative text, isolated captions, or charts without a standalone editorial article.',
    'A subsection or subheading inside one article is not a separate article.',
    'If one article occupies several separated columns or non-rectangular areas, return multiple tight rectangles for the same article.',
    'Each rectangle uses normalized page coordinates from 0 to 1000: x_min=left, y_min=top, x_max=right, y_max=bottom.',
    'Rectangles must be tight around that article and must avoid neighboring articles and advertisements. Do not draw one giant rectangle around multiple articles.',
    'headline_hint is a short visual transcription of the article headline. It is a hint, not a database key.',
    'Set confidence below 0.80 when the article boundary is genuinely uncertain; do not force certainty.',
    `This is independent visual pass ${passKind}.`,
    'Return only JSON matching the schema.'
  ].join(' ');
}

async function callVision(model: string, passKind: PassKind, source: SourceImage): Promise<Receipt> {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const userText = [
    'Audit this newspaper page visually and return all standalone editorial article regions.',
    'Coordinates are normalized to a 1000 x 1000 page coordinate system.',
    'Do not infer an article from database state; use only what is visible in the image.'
  ].join('\n');
  const body = {
    model,
    store: false,
    max_output_tokens: 6000,
    instructions: visionInstructions(passKind),
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: userText },
        { type: 'input_image', image_url: `data:${source.mimeType};base64,${source.buffer.toString('base64')}`, detail: 'high' }
      ]
    }],
    text: { format: visionSchema }
  };
  const promptSha256 = sha256(JSON.stringify(body));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const payload = JSON.parse(raw) as JsonRecord;
  const providerResponseId = text(payload.id);
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('Invalid provider response receipt.');
  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(outputText(payload)) as JsonRecord;
  } catch {
    throw new ReviewRequiredError('visual region response is not valid JSON');
  }
  return { parsed, providerResponseId, promptSha256, responseSha256: sha256(raw) };
}

function parseVisionArticles(parsed: JsonRecord) {
  if (!Array.isArray(parsed.articles) || parsed.articles.length < 1 || parsed.articles.length > 12) {
    throw new ReviewRequiredError('visual pass returned invalid article count');
  }
  return parsed.articles.map((raw, articleIndex) => {
    const item = record(raw);
    const headlineHint = text(item.headline_hint);
    const confidence = Number(item.confidence);
    const reason = text(item.reason);
    if (headlineHint.length < 2 || !Number.isFinite(confidence) || confidence < 0.80 || confidence > 1 || reason.length < 2) {
      throw new ReviewRequiredError(`visual article ${articleIndex} has invalid hint/confidence/reason`);
    }
    if (!Array.isArray(item.regions) || item.regions.length < 1 || item.regions.length > 8) {
      throw new ReviewRequiredError(`visual article ${articleIndex} has invalid regions`);
    }
    const regions = item.regions.map((rawRegion, regionIndex) => {
      const region = record(rawRegion);
      const value = {
        x_min: Number(region.x_min), y_min: Number(region.y_min),
        x_max: Number(region.x_max), y_max: Number(region.y_max)
      };
      if (!Object.values(value).every(Number.isInteger)
        || value.x_min < 0 || value.y_min < 0 || value.x_max > COORD_MAX || value.y_max > COORD_MAX
        || value.x_max <= value.x_min || value.y_max <= value.y_min
        || value.x_max - value.x_min < 8 || value.y_max - value.y_min < 8) {
        throw new ReviewRequiredError(`visual article ${articleIndex} region ${regionIndex} invalid`);
      }
      return value;
    });
    return { headline_hint: headlineHint, confidence, reason, regions } as VisionArticle;
  });
}

function normalizedBlockRect(block: OcrBlock, source: SourceImage): Region {
  return {
    x_min: Math.max(0, Math.min(COORD_MAX, block.x_min / source.width * COORD_MAX)),
    y_min: Math.max(0, Math.min(COORD_MAX, block.y_min / source.height * COORD_MAX)),
    x_max: Math.max(0, Math.min(COORD_MAX, block.x_max / source.width * COORD_MAX)),
    y_max: Math.max(0, Math.min(COORD_MAX, block.y_max / source.height * COORD_MAX))
  };
}

function intersectionArea(a: Region, b: Region) {
  return Math.max(0, Math.min(a.x_max, b.x_max) - Math.max(a.x_min, b.x_min))
    * Math.max(0, Math.min(a.y_max, b.y_max) - Math.max(a.y_min, b.y_min));
}

function area(rect: Region) {
  return Math.max(1e-6, (rect.x_max - rect.x_min) * (rect.y_max - rect.y_min));
}

function centerInsideExpanded(block: Region, region: Region) {
  const cx = (block.x_min + block.x_max) / 2;
  const cy = (block.y_min + block.y_max) / 2;
  return cx >= Math.max(0, region.x_min - CENTER_MARGIN)
    && cx <= Math.min(COORD_MAX, region.x_max + CENTER_MARGIN)
    && cy >= Math.max(0, region.y_min - CENTER_MARGIN)
    && cy <= Math.min(COORD_MAX, region.y_max + CENTER_MARGIN);
}

function articleScore(block: Region, article: VisionArticle) {
  let best = 0;
  for (const region of article.regions) {
    const coverage = intersectionArea(block, region) / area(block);
    const score = centerInsideExpanded(block, region) ? 1 + coverage : coverage >= 0.35 ? coverage : 0;
    best = Math.max(best, score);
  }
  return best;
}

function normalizeText(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(value: string) {
  const normalized = normalizeText(value);
  const result = new Set<string>();
  if (normalized.length === 1) result.add(normalized);
  for (let i = 0; i < normalized.length - 1; i += 1) result.add(normalized.slice(i, i + 2));
  return result;
}

function textSimilarity(a: string, b: string) {
  const aa = bigrams(a);
  const bb = bigrams(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const value of aa) if (bb.has(value)) intersection += 1;
  return (2 * intersection) / (aa.size + bb.size);
}

function chooseAnchor(article: VisionArticle, blocks: OcrBlock[]) {
  const maxHeight = Math.max(...blocks.map((block) => Math.max(1, block.y_max - block.y_min)));
  let best: OcrBlock | null = null;
  let bestScore = -1;
  for (const block of blocks) {
    const raw = block.block_text.trim();
    if (raw.length < 2) continue;
    const heightScore = Math.min(1, Math.max(1, block.y_max - block.y_min) / maxHeight);
    const score = 0.82 * textSimilarity(article.headline_hint, raw) + 0.18 * heightScore;
    if (score > bestScore) {
      bestScore = score;
      best = block;
    }
  }
  if (!best) throw new ReviewRequiredError('visual article has no usable headline anchor block');
  const raw = best.block_text.trim();
  const anchor = raw.length <= 100 ? raw : raw.slice(0, 100).trim();
  if (anchor.length < 2 || !best.block_text.toLowerCase().includes(anchor.toLowerCase())) {
    throw new ReviewRequiredError('derived visual headline anchor invalid');
  }
  return anchor;
}

function deriveGroups(articles: VisionArticle[], blocks: OcrBlock[], source: SourceImage, passKind: PassKind): InventoryGroup[] {
  const assigned = new Map<number, number[]>();
  const leftovers: number[] = [];
  let ambiguous = 0;

  for (const block of blocks) {
    const rect = normalizedBlockRect(block, source);
    const scores = articles
      .map((article, index) => ({ index, score: articleScore(rect, article) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);

    if (!scores.length) {
      leftovers.push(block.block_index);
      continue;
    }
    if (scores.length > 1 && scores[1].score > 0 && scores[0].score - scores[1].score < 0.08) ambiguous += 1;
    const winner = scores[0].index;
    const list = assigned.get(winner) || [];
    list.push(block.block_index);
    assigned.set(winner, list);
  }

  if (ambiguous > Math.max(2, Math.floor(blocks.length * 0.01))) {
    throw new ReviewRequiredError(`visual article regions overlap ambiguously for ${ambiguous} OCR blocks`);
  }

  const blockByIndex = new Map(blocks.map((block) => [block.block_index, block]));
  const groups: InventoryGroup[] = [];
  for (let articleIndex = 0; articleIndex < articles.length; articleIndex += 1) {
    const indices = (assigned.get(articleIndex) || []).sort((a, b) => a - b);
    if (!indices.length) throw new ReviewRequiredError(`visual article ${articleIndex} contains no OCR blocks`);
    const articleBlocks = indices.map((index) => blockByIndex.get(index)).filter(Boolean) as OcrBlock[];
    const article = articles[articleIndex];
    groups.push({
      group_kind: 'article',
      block_indices: indices,
      headline_anchor: chooseAnchor(article, articleBlocks),
      non_article_role: '',
      confidence: article.confidence,
      reason: `visual_regions_v4 pass=${passKind}; hint=${article.headline_hint}; regions=${JSON.stringify(article.regions)}; ${article.reason}`
    });
  }

  if (leftovers.length) {
    groups.push({
      group_kind: 'non_article',
      block_indices: leftovers.sort((a, b) => a - b),
      headline_anchor: '',
      non_article_role: 'outside_all_independently_detected_editorial_regions',
      confidence: 0.99,
      reason: `deterministic complement of visual article regions for pass ${passKind}`
    });
  }

  const seen = new Set<number>();
  for (const group of groups) {
    for (const index of group.block_indices) {
      if (seen.has(index)) throw new ReviewRequiredError(`derived visual partition duplicates block ${index}`);
      seen.add(index);
    }
  }
  if (seen.size !== blocks.length) throw new ReviewRequiredError(`derived visual partition incomplete: ${seen.size}/${blocks.length}`);
  return groups.sort((a, b) => Math.min(...a.block_indices) - Math.min(...b.block_indices));
}

async function persistPass(job: ClaimedJob, passKind: PassKind, model: string, receipt: Receipt, groups: InventoryGroup[]) {
  const { data, error } = await supabaseAdmin.rpc('record_source_page_article_inventory_pass_v3', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_pass_kind: passKind,
    p_model: model,
    p_provider_response_id: receipt.providerResponseId,
    p_prompt_sha256: receipt.promptSha256,
    p_response_sha256: receipt.responseSha256,
    p_groups: groups
  });
  if (error) throw new Error(error.message);
  return data;
}

async function yieldJob(job: ClaimedJob, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_source_page_article_inventory_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_stage: stage
  });
  if (error) throw new Error(error.message);
  return data;
}

async function reviewJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_reason: reason.slice(0, 3000)
  });
  if (error) throw new Error(`${reason}; review rpc: ${error.message}`);
  return data;
}

async function failJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_message: reason.slice(0, 3000),
    p_retryable: true
  });
  if (error) throw new Error(`${reason}; fail rpc: ${error.message}`);
  return data;
}

async function runVisualPass(job: ClaimedJob, blocks: OcrBlock[], passKind: PassKind, model: string) {
  const source = await loadSource(job);
  const receipt = await callVision(model, passKind, source);
  const articles = parseVisionArticles(receipt.parsed);
  const groups = deriveGroups(articles, blocks, source, passKind);
  const stored = await persistPass(job, passKind, model, receipt, groups);
  return { article_regions: articles.length, groups: groups.length, stored };
}

export async function runArticleInventoryWorkerV4VisionStep(jobId?: string) {
  const job = await claim(jobId);
  if (!job) return { claimed: 0, job_id: jobId || null, worker_version: 'article_inventory_v4_visual_regions' };

  try {
    const mapperModel = process.env.OPENAI_INVENTORY_MAPPER_MODEL || VISION_MODEL;
    const criticModel = process.env.OPENAI_INVENTORY_CRITIC_MODEL || 'gpt-4o';
    const adjudicatorModel = process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL || 'gpt-4o-mini';
    requireDistinctModels([mapperModel, criticModel], 'visual blind inventory');
    if (job.requires_third_pass) requireDistinctModels([mapperModel, criticModel, adjudicatorModel], 'visual blind adjudication');

    const blocks = await loadBlocks(job);
    const existing = await passKinds(job.id);

    if (!existing.has('mapper')) {
      const result = await runVisualPass(job, blocks, 'mapper', mapperModel);
      return { claimed: 1, job_id: job.id, stage: 'visual_mapper_v4', result, yield: await yieldJob(job, 'visual_mapper_v4') };
    }
    if (!existing.has('critic')) {
      const result = await runVisualPass(job, blocks, 'critic', criticModel);
      return { claimed: 1, job_id: job.id, stage: 'visual_critic_v4', result, yield: await yieldJob(job, 'visual_critic_v4') };
    }
    if (job.requires_third_pass && !existing.has('adjudicator')) {
      const result = await runVisualPass(job, blocks, 'adjudicator', adjudicatorModel);
      return { claimed: 1, job_id: job.id, stage: 'visual_adjudicator_v4', result, yield: await yieldJob(job, 'visual_adjudicator_v4') };
    }

    const released = await yieldJob(job, 'visual_partition_ready_v4');
    const delegated = await runArticleInventoryWorkerV3Step(job.id);
    return { claimed: 1, job_id: job.id, stage: 'visual_delegate_v4', released, delegated };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown visual inventory v4 error';
    if (error instanceof ReviewRequiredError) {
      return { claimed: 1, job_id: job.id, stage: 'visual_review_required_v4', error: message, result: await reviewJob(job, message) };
    }
    return { claimed: 1, job_id: job.id, stage: 'visual_failed_v4', error: message, result: await failJob(job, message) };
  }
}

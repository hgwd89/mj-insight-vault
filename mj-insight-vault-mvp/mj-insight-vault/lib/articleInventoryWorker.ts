import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL, VISION_MODEL } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;
type BlindPassKind = 'mapper' | 'critic' | 'adjudicator';
type MappingPassKind = 'mapper' | 'critic';

type ClaimedInventoryJob = {
  id: string;
  page_identity_source_image_id: string;
  inventory_source_image_id: string;
  freeze_receipt_id: string;
  source_ocr_json_sha256: string;
  block_count: number;
  existing_article_count: number;
  requires_third_pass: boolean;
  inventory_version: string;
  attempt_count: number;
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

type InventoryGroup = {
  group_kind: 'article' | 'non_article';
  block_indices: number[];
  headline_anchor: string;
  non_article_role: string;
  confidence: number;
  reason: string;
};

type MappingRow = {
  group_fingerprint: string;
  article_id: string;
  confidence: number;
  rationale: string;
};

class ReviewRequiredError extends Error {}
class StructuralOutputError extends Error {}

const CALL_TIMEOUT_MS = 180_000;
const LEASE_SECONDS = 900;
const MIN_CONFIDENCE = 0.8;

const INVENTORY_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'mj_blind_page_article_inventory',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['groups'],
    properties: {
      groups: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['group_kind', 'block_indices', 'headline_anchor', 'non_article_role', 'confidence', 'reason'],
          properties: {
            group_kind: { type: 'string', enum: ['article', 'non_article'] },
            block_indices: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'integer', minimum: 0 }
            },
            headline_anchor: { type: 'string' },
            non_article_role: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          }
        }
      }
    }
  }
} as const;

const MAPPING_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'mj_inventory_article_mapping',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['mappings'],
    properties: {
      mappings: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['group_fingerprint', 'article_id', 'confidence', 'rationale'],
          properties: {
            group_fingerprint: { type: 'string' },
            article_id: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            rationale: { type: 'string' }
          }
        }
      }
    }
  }
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return text(error.message || error.error || error.details || error);
  return text(error) || 'article inventory worker failed';
}

function extractResponseText(responseJson: unknown) {
  const json = responseJson as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  const parts: string[] = [];
  for (const item of json.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string' && content.text.trim()) parts.push(content.text.trim());
    }
  }
  return parts.join('\n').trim();
}

function blindModels(job: ClaimedInventoryJob) {
  const mapper = process.env.OPENAI_INVENTORY_MAPPER_MODEL?.trim() || VISION_MODEL;
  const critic = process.env.OPENAI_INVENTORY_CRITIC_MODEL?.trim() || 'gpt-4o';
  const adjudicator = process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL?.trim() || '';
  if (!mapper || !critic || mapper === critic) {
    throw new Error('Inventory mapper and critic models must be configured and distinct.');
  }
  if (job.requires_third_pass && (!adjudicator || adjudicator === mapper || adjudicator === critic)) {
    throw new Error('OPENAI_INVENTORY_ADJUDICATOR_MODEL must be configured and distinct for third-pass pages.');
  }
  return { mapper, critic, adjudicator };
}

function mappingModels() {
  const mapper = process.env.OPENAI_INVENTORY_MAPPING_MAPPER_MODEL?.trim() || TEXT_MODEL;
  const fallbackCritic = mapper === 'gpt-4o' ? 'gpt-4.1' : 'gpt-4o';
  const critic = process.env.OPENAI_INVENTORY_MAPPING_CRITIC_MODEL?.trim() || fallbackCritic;
  if (!mapper || !critic || mapper === critic) {
    throw new Error('Inventory mapping mapper and critic models must be configured and distinct.');
  }
  return { mapper, critic };
}

async function callResponsesJson(input: {
  model: string;
  instructions: string;
  userText: string;
  responseFormat: typeof INVENTORY_RESPONSE_FORMAT | typeof MAPPING_RESPONSE_FORMAT;
  image?: { buffer: Buffer; mimeType: string };
}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');

  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: input.userText }];
  if (input.image) {
    content.push({
      type: 'input_image',
      image_url: `data:${input.image.mimeType || 'image/jpeg'};base64,${input.image.buffer.toString('base64')}`,
      detail: 'high'
    });
  }

  const promptSha = sha256([
    input.model,
    input.instructions,
    input.userText,
    input.image ? `image_sha256=${sha256(input.image.buffer)}` : ''
  ].join('\n---\n'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        store: false,
        max_output_tokens: 12000,
        instructions: input.instructions,
        input: [{ role: 'user', content }],
        text: { format: input.responseFormat }
      })
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`OpenAI Responses API failed: ${res.status} ${res.statusText} ${raw.slice(0, 2000)}`);
    const responseJson = JSON.parse(raw) as JsonRecord;
    const providerResponseId = text(responseJson.id);
    const outputText = extractResponseText(responseJson);
    if (!providerResponseId || !outputText) throw new Error('OpenAI response receipt or output_text is missing.');
    return {
      value: JSON.parse(outputText) as unknown,
      providerResponseId,
      promptSha,
      responseSha: sha256(raw)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function claimOneJob() {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_v1', {
    p_lease_seconds: LEASE_SECONDS
  });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job: ClaimedInventoryJob = {
    id: text(row.id),
    page_identity_source_image_id: text(row.page_identity_source_image_id),
    inventory_source_image_id: text(row.inventory_source_image_id),
    freeze_receipt_id: text(row.freeze_receipt_id),
    source_ocr_json_sha256: text(row.source_ocr_json_sha256),
    block_count: Number(row.block_count || 0),
    existing_article_count: Number(row.existing_article_count || 0),
    requires_third_pass: row.requires_third_pass === true,
    inventory_version: text(row.inventory_version),
    attempt_count: Number(row.attempt_count || 0),
    lease_token: text(row.lease_token)
  };
  if (!job.id || !job.inventory_source_image_id || !job.lease_token || !job.source_ocr_json_sha256) {
    throw new Error('Invalid claimed inventory job.');
  }
  return job;
}

async function renewLease(job: ClaimedInventoryJob) {
  const { error } = await supabaseAdmin.rpc('renew_source_page_article_inventory_job_lease_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_lease_seconds: LEASE_SECONDS
  });
  if (error) throw error;
}

async function loadBlindInput(job: ClaimedInventoryJob) {
  const [{ data: source, error: sourceError }, { data: blocks, error: blockError }] = await Promise.all([
    supabaseAdmin
      .from('source_images')
      .select('id,storage_path,mime_type,width,height,publication_date')
      .eq('id', job.inventory_source_image_id)
      .single(),
    supabaseAdmin
      .from('source_ocr_blocks_v1')
      .select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256')
      .eq('source_image_id', job.inventory_source_image_id)
      .eq('page_index', 0)
      .order('block_index', { ascending: true })
  ]);
  if (sourceError) throw sourceError;
  if (blockError) throw blockError;
  if (!source?.storage_path) throw new Error(`Inventory source image is missing: ${job.inventory_source_image_id}`);

  const typedBlocks = (blocks || []).map((row) => ({
    block_index: Number(row.block_index),
    block_text: text(row.block_text),
    x_min: Number(row.x_min || 0),
    y_min: Number(row.y_min || 0),
    x_max: Number(row.x_max || 0),
    y_max: Number(row.y_max || 0),
    ocr_confidence: Number(row.ocr_confidence || 0),
    source_ocr_json_sha256: text(row.source_ocr_json_sha256)
  })) as OcrBlock[];

  if (typedBlocks.length !== job.block_count) {
    throw new Error(`Inventory block count changed: expected=${job.block_count} actual=${typedBlocks.length}`);
  }
  if (typedBlocks.some((block) => block.source_ocr_json_sha256 !== job.source_ocr_json_sha256)) {
    throw new Error('Inventory OCR block hash no longer matches the frozen job.');
  }

  const download = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(source.storage_path);
  if (download.error) throw download.error;
  if (!download.data) throw new Error('Inventory source image download returned no data.');
  const imageBuffer = Buffer.from(await download.data.arrayBuffer());

  return {
    source,
    blocks: typedBlocks,
    image: { buffer: imageBuffer, mimeType: text(source.mime_type) || 'image/jpeg' }
  };
}

function blocksForPrompt(blocks: OcrBlock[]) {
  return blocks.map((block) => [
    `[BLOCK ${block.block_index}] bbox=(${block.x_min},${block.y_min})-(${block.x_max},${block.y_max}) confidence=${block.ocr_confidence.toFixed(4)}`,
    block.block_text
  ].join('\n')).join('\n\n');
}

function blindInstructions(passKind: BlindPassKind) {
  const role = passKind === 'mapper'
    ? 'You are the first blind newspaper-page inventory analyst.'
    : passKind === 'critic'
      ? 'You are an independent second blind newspaper-page inventory analyst. Do not assume another analyst exists.'
      : 'You are an independent adjudication analyst for a high-risk newspaper page. Make your own blind inventory from the raw page.';
  return [
    role,
    'The goal is exhaustive article discovery, not summarization and not thematic analysis.',
    'You are NOT given the existing article registry. Do not infer or guess how many articles the database already contains.',
    'Use the page image and OCR block coordinates together.',
    'Partition EVERY supplied OCR block exactly once. There is no maximum article count.',
    'An article group is one coherent editorial article, including attached subheadline, body, figure/table/caption blocks when visually part of that article.',
    'Do not merge neighboring articles merely because they discuss a similar topic.',
    'Do not split a single multi-column article merely because its OCR blocks are separated.',
    'Ads, mastheads, page furniture, standalone navigation, unrelated captions, and other non-editorial material must be non_article groups.',
    'For every article group, headline_anchor must be an exact contiguous substring from one OCR block in that group.',
    'If any grouping is genuinely uncertain, report confidence below 0.80; the pipeline will stop for review rather than forcing a result.',
    'Return only the requested JSON.'
  ].join('\n');
}

function blindUserText(job: ClaimedInventoryJob, blocks: OcrBlock[], passKind: BlindPassKind, repair?: string) {
  return [
    `inventory_version=${job.inventory_version}`,
    `pass_kind=${passKind}`,
    `source_ocr_json_sha256=${job.source_ocr_json_sha256}`,
    `expected_block_count=${job.block_count}`,
    repair ? `Previous structural validation failed. Repair only this issue while re-checking the whole page: ${repair}` : '',
    '',
    'OCR BLOCKS:',
    blocksForPrompt(blocks)
  ].filter(Boolean).join('\n');
}

function parseInventoryGroups(value: unknown, blocks: OcrBlock[]) {
  const root = isRecord(value) ? value : {};
  if (!Array.isArray(root.groups) || root.groups.length === 0) throw new StructuralOutputError('groups array is missing');
  const allowed = new Map(blocks.map((block) => [block.block_index, block]));
  const used = new Set<number>();
  const groups: InventoryGroup[] = [];

  for (const raw of root.groups) {
    if (!isRecord(raw)) throw new StructuralOutputError('group is not an object');
    const groupKind = text(raw.group_kind);
    if (groupKind !== 'article' && groupKind !== 'non_article') throw new StructuralOutputError('invalid group_kind');
    if (!Array.isArray(raw.block_indices) || raw.block_indices.length === 0) throw new StructuralOutputError('empty block_indices');
    const indices = Array.from(new Set(raw.block_indices.map(Number))).sort((a, b) => a - b);
    if (indices.some((index) => !Number.isInteger(index) || !allowed.has(index))) throw new StructuralOutputError('unknown block index');
    for (const index of indices) {
      if (used.has(index)) throw new StructuralOutputError(`block ${index} assigned more than once`);
      used.add(index);
    }
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
      throw new ReviewRequiredError(`blind inventory confidence below ${MIN_CONFIDENCE}`);
    }
    const headlineAnchor = text(raw.headline_anchor);
    const nonArticleRole = text(raw.non_article_role);
    if (groupKind === 'article') {
      if (!headlineAnchor) throw new StructuralOutputError('article headline_anchor is missing');
      const anchorFound = indices.some((index) => allowed.get(index)!.block_text.toLowerCase().includes(headlineAnchor.toLowerCase()));
      if (!anchorFound) throw new StructuralOutputError(`headline_anchor is not present in its group: ${headlineAnchor}`);
    } else if (!nonArticleRole) {
      throw new StructuralOutputError('non_article_role is missing');
    }
    groups.push({
      group_kind: groupKind,
      block_indices: indices,
      headline_anchor: groupKind === 'article' ? headlineAnchor : '',
      non_article_role: groupKind === 'non_article' ? nonArticleRole : '',
      confidence,
      reason: text(raw.reason).slice(0, 1200)
    });
  }

  if (used.size !== blocks.length) {
    const missing = blocks.map((block) => block.block_index).filter((index) => !used.has(index));
    throw new StructuralOutputError(`block partition incomplete; missing=${missing.join(',')}`);
  }
  return groups;
}

async function existingBlindPassKinds(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_pass_runs_v1')
    .select('pass_kind')
    .eq('job_id', jobId);
  if (error) throw error;
  return new Set((data || []).map((row) => text(row.pass_kind)).filter(Boolean));
}

async function runBlindPass(job: ClaimedInventoryJob, input: Awaited<ReturnType<typeof loadBlindInput>>, passKind: BlindPassKind, model: string) {
  await renewLease(job);
  let lastStructuralError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const receipt = await callResponsesJson({
      model,
      instructions: blindInstructions(passKind),
      userText: blindUserText(job, input.blocks, passKind, attempt === 2 ? lastStructuralError : undefined),
      responseFormat: INVENTORY_RESPONSE_FORMAT,
      image: input.image
    });
    try {
      const groups = parseInventoryGroups(receipt.value, input.blocks);
      const { data, error } = await supabaseAdmin.rpc('replace_source_page_article_inventory_pass_v1', {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_pass_kind: passKind,
        p_model: model,
        p_provider_response_id: receipt.providerResponseId,
        p_prompt_sha256: receipt.promptSha,
        p_response_sha256: receipt.responseSha,
        p_groups: groups
      });
      if (error) throw error;
      return data;
    } catch (error) {
      if (error instanceof ReviewRequiredError) throw error;
      if (error instanceof StructuralOutputError && attempt === 1) {
        lastStructuralError = error.message;
        continue;
      }
      throw error;
    }
  }
  throw new Error('Blind inventory pass exhausted repair attempt.');
}

async function runRequiredBlindPasses(job: ClaimedInventoryJob, input: Awaited<ReturnType<typeof loadBlindInput>>) {
  const existing = await existingBlindPassKinds(job.id);
  const models = blindModels(job);
  const required: Array<[BlindPassKind, string]> = [
    ['mapper', models.mapper],
    ['critic', models.critic]
  ];
  if (job.requires_third_pass) required.push(['adjudicator', models.adjudicator]);
  for (const [passKind, model] of required) {
    if (!existing.has(passKind)) await runBlindPass(job, input, passKind, model);
  }
}

async function blindConsensusState(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_groups_v1')
    .select('pass_kind,group_kind,group_fingerprint')
    .eq('job_id', job.id);
  if (error) throw error;
  const required = job.requires_third_pass ? ['mapper', 'critic', 'adjudicator'] : ['mapper', 'critic'];
  const signatures = new Map<string, string>();
  for (const passKind of required) {
    const fingerprint = (data || [])
      .filter((row) => text(row.pass_kind) === passKind && text(row.group_kind) === 'article')
      .map((row) => text(row.group_fingerprint))
      .sort()
      .join('|');
    signatures.set(passKind, fingerprint);
  }
  const uniqueSignatures = new Set(signatures.values());
  const mapperCount = signatures.get('mapper') ? signatures.get('mapper')!.split('|').filter(Boolean).length : 0;
  return { agrees: uniqueSignatures.size === 1, articleCount: mapperCount };
}

async function loadMappingInput(job: ClaimedInventoryJob) {
  const [{ data: groups, error: groupError }, { data: captures, error: captureError }, { data: candidates, error: candidateError }] = await Promise.all([
    supabaseAdmin
      .from('source_page_article_inventory_consensus_groups_v2')
      .select('group_fingerprint,block_indices,headline_anchor,confidence,group_text')
      .eq('job_id', job.id)
      .order('group_fingerprint', { ascending: true }),
    supabaseAdmin
      .from('source_page_capture_map_v1')
      .select('source_image_id')
      .eq('page_identity_source_image_id', job.page_identity_source_image_id),
    supabaseAdmin.rpc('inventory_mapping_candidates_v2', { p_job_id: job.id })
  ]);
  if (groupError) throw groupError;
  if (captureError) throw captureError;
  if (candidateError) throw candidateError;
  const captureIds = Array.from(new Set((captures || []).map((row) => text(row.source_image_id)).filter(Boolean)));
  if (!captureIds.length) throw new Error('No source captures found for inventory mapping.');
  const { data: articles, error: articleError } = await supabaseAdmin
    .from('formal_corpus_articles_v1')
    .select('id,headline,article_date,source_image_id')
    .in('source_image_id', captureIds)
    .order('id', { ascending: true });
  if (articleError) throw articleError;
  return { groups: groups || [], articles: articles || [], candidates: Array.isArray(candidates) ? candidates : [] };
}

function mappingInstructions(passKind: MappingPassKind) {
  return [
    passKind === 'mapper'
      ? 'You map blind-discovered newspaper article groups to the already stored article records on the same page.'
      : 'You are an independent critic mapping blind-discovered newspaper article groups to stored article records on the same page.',
    'This is identity resolution only. Do not change the article inventory and do not make analytical claims.',
    'Produce a complete one-to-one bijection: every group exactly once and every supplied article exactly once.',
    'Use OCR group text, headline anchors, stored headlines/dates, and candidate similarity only as matching evidence.',
    'Do not force uncertainty. If any mapping is not at least 0.80 confident, return the honest lower confidence; the pipeline will stop for review.',
    'Return only the requested JSON.'
  ].join('\n');
}

function mappingUserText(job: ClaimedInventoryJob, input: Awaited<ReturnType<typeof loadMappingInput>>, passKind: MappingPassKind) {
  return JSON.stringify({
    task: 'one_to_one_article_identity_mapping',
    job_id: job.id,
    pass_kind: passKind,
    blind_groups: input.groups,
    stored_articles: input.articles,
    reciprocal_headline_candidates: input.candidates,
    required_group_count: input.groups.length,
    required_article_count: input.articles.length
  });
}

function parseMappings(value: unknown, groupFingerprints: Set<string>, articleIds: Set<string>) {
  const root = isRecord(value) ? value : {};
  if (!Array.isArray(root.mappings)) throw new StructuralOutputError('mappings array missing');
  if (root.mappings.length !== groupFingerprints.size) throw new StructuralOutputError('mapping row count mismatch');
  const seenGroups = new Set<string>();
  const seenArticles = new Set<string>();
  const rows: MappingRow[] = [];
  for (const raw of root.mappings) {
    if (!isRecord(raw)) throw new StructuralOutputError('mapping row is not an object');
    const groupFingerprint = text(raw.group_fingerprint);
    const articleId = text(raw.article_id);
    const confidence = Number(raw.confidence);
    if (!groupFingerprints.has(groupFingerprint) || seenGroups.has(groupFingerprint)) throw new StructuralOutputError('invalid or duplicate group mapping');
    if (!articleIds.has(articleId) || seenArticles.has(articleId)) throw new StructuralOutputError('invalid or duplicate article mapping');
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
      throw new ReviewRequiredError(`article identity mapping confidence below ${MIN_CONFIDENCE}`);
    }
    seenGroups.add(groupFingerprint);
    seenArticles.add(articleId);
    rows.push({
      group_fingerprint: groupFingerprint,
      article_id: articleId,
      confidence,
      rationale: text(raw.rationale).slice(0, 1200)
    });
  }
  if (seenGroups.size !== groupFingerprints.size || seenArticles.size !== articleIds.size) {
    throw new StructuralOutputError('mapping is not bijective');
  }
  return rows;
}

async function existingMappingPassKinds(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_mapping_pass_runs_v2')
    .select('pass_kind')
    .eq('job_id', jobId);
  if (error) throw error;
  return new Set((data || []).map((row) => text(row.pass_kind)).filter(Boolean));
}

async function runMappingPass(job: ClaimedInventoryJob, input: Awaited<ReturnType<typeof loadMappingInput>>, passKind: MappingPassKind, model: string) {
  await renewLease(job);
  const receipt = await callResponsesJson({
    model,
    instructions: mappingInstructions(passKind),
    userText: mappingUserText(job, input, passKind),
    responseFormat: MAPPING_RESPONSE_FORMAT
  });
  const rows = parseMappings(
    receipt.value,
    new Set(input.groups.map((row) => text(row.group_fingerprint)).filter(Boolean)),
    new Set(input.articles.map((row) => text(row.id)).filter(Boolean))
  );
  const { data, error } = await supabaseAdmin.rpc('replace_inventory_mapping_pass_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_pass_kind: passKind,
    p_model: model,
    p_provider_response_id: receipt.providerResponseId,
    p_prompt_sha256: receipt.promptSha,
    p_response_sha256: receipt.responseSha,
    p_mappings: rows
  });
  if (error) throw error;
  return data;
}

async function ensureMappingProof(job: ClaimedInventoryJob) {
  const { data: auto, error: autoError } = await supabaseAdmin.rpc('resolve_inventory_mapping_auto_v2', { p_job_id: job.id });
  if (autoError) throw autoError;
  const unresolved = isRecord(auto) ? Number(auto.unresolved || 0) : job.existing_article_count;
  if (unresolved <= 0) return;

  const input = await loadMappingInput(job);
  if (input.groups.length !== job.existing_article_count || input.articles.length !== job.existing_article_count) {
    throw new ReviewRequiredError('Blind group/article counts are not equal before identity mapping.');
  }
  const existing = await existingMappingPassKinds(job.id);
  const models = mappingModels();
  if (!existing.has('mapper')) await runMappingPass(job, input, 'mapper', models.mapper);
  if (!existing.has('critic')) await runMappingPass(job, input, 'critic', models.critic);
}

async function finalize(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin.rpc('finalize_source_page_article_inventory_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw error;
  return data;
}

async function markReview(job: ClaimedInventoryJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_reason: reason
  });
  if (error) throw error;
  return data;
}

async function persistFailure(job: ClaimedInventoryJob, error: unknown) {
  const message = errorMessage(error);
  const retryable = !message.includes('is not configured')
    && !message.includes('must be configured and distinct')
    && !message.includes('freeze_stale');
  const { data, error: persistenceError } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_message: message,
    p_retryable: retryable
  });
  if (persistenceError) throw persistenceError;
  return data;
}

export async function getArticleInventoryStatus() {
  const [{ data: gate, error: gateError }, { data: jobs, error: jobsError }] = await Promise.all([
    supabaseAdmin.from('source_page_article_inventory_gate_v1').select('*').maybeSingle(),
    supabaseAdmin.from('source_page_article_inventory_jobs_v1').select('status,requires_third_pass')
  ]);
  if (gateError) throw gateError;
  if (jobsError) throw jobsError;
  const counts: Record<string, number> = {};
  for (const row of jobs || []) {
    const status = text(row.status) || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    gate,
    counts,
    third_pass_jobs: (jobs || []).filter((row) => row.requires_third_pass === true).length
  };
}

export async function runArticleInventoryWorkerStep() {
  const job = await claimOneJob();
  if (!job) return { claimed: 0, completed: 0, needs_review: 0, discovery_required: 0, failed: 0 };
  try {
    const blindInput = await loadBlindInput(job);
    await runRequiredBlindPasses(job, blindInput);

    const consensus = await blindConsensusState(job);
    if (!consensus.agrees || consensus.articleCount !== job.existing_article_count) {
      const result = await finalize(job);
      const status = isRecord(result) ? text(result.status) : '';
      return {
        claimed: 1,
        completed: status === 'completed' ? 1 : 0,
        needs_review: status === 'needs_review' ? 1 : 0,
        discovery_required: status === 'discovery_required' ? 1 : 0,
        failed: 0,
        job_id: job.id,
        result
      };
    }

    await ensureMappingProof(job);
    const result = await finalize(job);
    const status = isRecord(result) ? text(result.status) : '';
    return {
      claimed: 1,
      completed: status === 'completed' ? 1 : 0,
      needs_review: status === 'needs_review' ? 1 : 0,
      discovery_required: status === 'discovery_required' ? 1 : 0,
      failed: 0,
      job_id: job.id,
      result
    };
  } catch (error) {
    if (error instanceof ReviewRequiredError) {
      const result = await markReview(job, error.message);
      return { claimed: 1, completed: 0, needs_review: 1, discovery_required: 0, failed: 0, job_id: job.id, result };
    }
    const result = await persistFailure(job, error);
    return {
      claimed: 1,
      completed: 0,
      needs_review: 0,
      discovery_required: 0,
      failed: 1,
      job_id: job.id,
      error: errorMessage(error),
      result
    };
  }
}

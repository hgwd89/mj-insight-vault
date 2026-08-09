import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from './supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL, VISION_MODEL } from './openai';

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

type ArticleCandidate = {
  candidate_key: string;
  article_ordinal: number;
  headline_anchor: string;
  group_block_indices: number[];
};

type FrozenArticle = {
  article_id: string;
  article_ordinal: number;
  title: string;
  body: string;
  source_month: string;
};

type MappingRow = {
  candidate_key: string;
  article_id: string;
  decision: 'match';
  confidence: number;
  reason: string;
};

class ReviewRequiredError extends Error {}

const LEASE_SECONDS = 240;
const REVIEW_ATTEMPT_LIMIT = 2;

const blindSchema = {
  name: 'blind_article_inventory',
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
            block_indices: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
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

const mappingSchema = {
  name: 'inventory_article_mapping',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['mappings'],
    properties: {
      mappings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['candidate_key', 'article_id', 'decision', 'confidence', 'reason'],
          properties: {
            candidate_key: { type: 'string' },
            article_id: { type: 'string' },
            decision: { type: 'string', enum: ['match'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          }
        }
      }
    }
  }
} as const;

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object response.');
  return value as JsonRecord;
}

function asString(value: unknown, field: string) {
  if (typeof value !== 'string') throw new Error(`Expected string: ${field}`);
  return value;
}

function asNumber(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected finite number: ${field}`);
  return value;
}

function asArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`Expected array: ${field}`);
  return value;
}

function requireDistinctModels(models: string[], context: string) {
  if (new Set(models).size !== models.length) {
    throw new ReviewRequiredError(`${context}: independent_passes_require_distinct_models`);
  }
}

function parseBlindGroups(parsed: JsonRecord, blocks: OcrBlock[]): InventoryGroup[] {
  const rows = asArray(parsed.groups, 'groups');
  if (rows.length === 0) throw new ReviewRequiredError('Blind inventory returned zero groups.');
  const blockMap = new Map(blocks.map((block) => [block.block_index, block]));
  const seen = new Set<number>();
  const groups: InventoryGroup[] = rows.map((raw, index) => {
    const item = asRecord(raw);
    const groupKind = asString(item.group_kind, `groups[${index}].group_kind`);
    if (groupKind !== 'article' && groupKind !== 'non_article') throw new Error('Invalid group_kind.');
    const indices = asArray(item.block_indices, `groups[${index}].block_indices`).map((value) => {
      const n = asNumber(value, 'block_index');
      if (!Number.isInteger(n)) throw new Error('block_index must be integer.');
      if (!blockMap.has(n)) throw new ReviewRequiredError(`Unknown block index ${n}.`);
      if (seen.has(n)) throw new ReviewRequiredError(`Block ${n} was assigned to multiple groups.`);
      seen.add(n);
      return n;
    });
    if (indices.length === 0 || new Set(indices).size !== indices.length) throw new ReviewRequiredError('Invalid group block partition.');
    const headlineAnchor = asString(item.headline_anchor, 'headline_anchor').trim();
    const nonArticleRole = asString(item.non_article_role, 'non_article_role').trim();
    const confidence = asNumber(item.confidence, 'confidence');
    const reason = asString(item.reason, 'reason').trim();
    if (confidence < 0.8) throw new ReviewRequiredError(`Low-confidence blind inventory group: ${confidence}.`);
    if (groupKind === 'article') {
      if (!headlineAnchor) throw new ReviewRequiredError('Article group missing headline_anchor.');
      const normalizedAnchor = headlineAnchor.replace(/\s+/g, '');
      const anchorPresent = indices.some((blockIndex) =>
        (blockMap.get(blockIndex)?.block_text || '').replace(/\s+/g, '').includes(normalizedAnchor)
      );
      if (!anchorPresent) throw new ReviewRequiredError('Article headline_anchor is not a substring of its OCR blocks.');
    } else if (!nonArticleRole) {
      throw new ReviewRequiredError('Non-article group missing role.');
    }
    return {
      group_kind: groupKind,
      block_indices: indices,
      headline_anchor: headlineAnchor,
      non_article_role: nonArticleRole,
      confidence,
      reason
    };
  });
  if (seen.size !== blocks.length) {
    const missing = blocks.filter((block) => !seen.has(block.block_index)).map((block) => block.block_index);
    throw new ReviewRequiredError(`Blind inventory omitted blocks: ${missing.slice(0, 20).join(',')}`);
  }
  return groups;
}

function parseMappings(parsed: JsonRecord, candidates: ArticleCandidate[], articles: FrozenArticle[]): MappingRow[] {
  const rows = asArray(parsed.mappings, 'mappings');
  const candidateKeys = new Set(candidates.map((candidate) => candidate.candidate_key));
  const articleIds = new Set(articles.map((article) => article.article_id));
  const seenCandidates = new Set<string>();
  const seenArticles = new Set<string>();
  const mappings = rows.map((raw, index) => {
    const item = asRecord(raw);
    const candidateKey = asString(item.candidate_key, `mappings[${index}].candidate_key`);
    const articleId = asString(item.article_id, `mappings[${index}].article_id`);
    const decision = asString(item.decision, `mappings[${index}].decision`);
    const confidence = asNumber(item.confidence, `mappings[${index}].confidence`);
    const reason = asString(item.reason, `mappings[${index}].reason`).trim();
    if (decision !== 'match') throw new ReviewRequiredError('Mapping pass returned a non-match decision.');
    if (!candidateKeys.has(candidateKey) || !articleIds.has(articleId)) throw new ReviewRequiredError('Mapping pass referenced unknown identities.');
    if (confidence < 0.8) throw new ReviewRequiredError(`Low-confidence mapping: ${confidence}.`);
    if (seenCandidates.has(candidateKey) || seenArticles.has(articleId)) throw new ReviewRequiredError('Mapping pass is not bijective.');
    seenCandidates.add(candidateKey);
    seenArticles.add(articleId);
    return { candidate_key: candidateKey, article_id: articleId, decision: 'match' as const, confidence, reason };
  });
  if (mappings.length !== candidates.length || mappings.length !== articles.length) {
    throw new ReviewRequiredError('Mapping pass did not cover the full candidate/article bijection.');
  }
  return mappings;
}

function responseOutputText(payload: JsonRecord) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const itemRaw of output) {
    const item = itemRaw && typeof itemRaw === 'object' ? (itemRaw as JsonRecord) : {};
    const content = Array.isArray(item.content) ? item.content : [];
    for (const partRaw of content) {
      const part = partRaw && typeof partRaw === 'object' ? (partRaw as JsonRecord) : {};
      if (typeof part.text === 'string' && part.text.trim()) return part.text;
    }
  }
  throw new Error('OpenAI response missing output text.');
}

async function callStructured(args: {
  model: string;
  system: string;
  user: string;
  schema: typeof blindSchema | typeof mappingSchema;
}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const body = {
    model: args.model,
    store: false,
    max_output_tokens: 12000,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: args.system }] },
      { role: 'user', content: [{ type: 'input_text', text: args.user }] }
    ],
    text: { format: { type: 'json_schema', ...args.schema } }
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
  const providerResponseId = asString(payload.id, 'response.id');
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('OpenAI response id is not a real provider receipt.');
  const outputText = responseOutputText(payload);
  const parsed = JSON.parse(outputText) as JsonRecord;
  return { parsed, raw, promptSha256, responseSha256: sha256(raw), providerResponseId };
}

async function claimOneJob(jobId?: string) {
  const claimRpc = jobId ? 'claim_source_page_article_inventory_job_smoke_v1' : 'claim_source_page_article_inventory_job_v2';
  const claimArgs = jobId ? { p_job_id: jobId, p_lease_seconds: LEASE_SECONDS } : { p_lease_seconds: LEASE_SECONDS };
  const { data, error } = await supabaseAdmin.rpc(claimRpc, claimArgs);
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data[0] : data) || null) as ClaimedInventoryJob | null;
}

async function loadBlocks(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256')
    .eq('job_id', job.id)
    .order('block_index', { ascending: true });
  if (error) throw new Error(error.message);
  const blocks = (data || []) as OcrBlock[];
  if (blocks.length !== job.block_count) throw new ReviewRequiredError(`Inventory block count mismatch: ${blocks.length} != ${job.block_count}.`);
  if (blocks.some((block) => block.source_ocr_json_sha256 !== job.source_ocr_json_sha256)) {
    throw new ReviewRequiredError('Inventory block provenance drift detected.');
  }
  return blocks;
}

async function listPassKinds(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_pass_runs_v1')
    .select('pass_kind')
    .eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((row) => String(row.pass_kind)));
}

async function persistBlindPass(job: ClaimedInventoryJob, passKind: BlindPassKind, model: string, receipt: Awaited<ReturnType<typeof callStructured>>, groups: InventoryGroup[]) {
  const { data, error } = await supabaseAdmin.rpc('record_source_page_article_inventory_pass_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_pass_kind: passKind,
    p_model: model,
    p_provider_response_id: receipt.providerResponseId,
    p_prompt_sha256: receipt.promptSha256,
    p_response_sha256: receipt.responseSha256,
    p_groups: groups.map((group) => ({
      group_kind: group.group_kind,
      block_indices: group.block_indices,
      headline_anchor: group.headline_anchor,
      non_article_role: group.non_article_role,
      confidence: group.confidence,
      reason: group.reason
    }))
  });
  if (error) throw new Error(error.message);
  return data;
}

async function buildBlindPrompt(job: ClaimedInventoryJob, blocks: OcrBlock[], passKind: BlindPassKind) {
  const system = [
    'You are a blind page-level article inventory auditor.',
    'Use only the OCR blocks supplied in this request.',
    'Do not use the existing article table, filenames, upload batch names, or prior pass outputs.',
    'Partition every OCR block exactly once into article or non_article groups.',
    'Article groups must represent distinct editorial articles and include a verbatim headline substring from one of their own OCR blocks.',
    'Non-article groups include mastheads, folios, page labels, ads, navigation, decorative text, and other non-editorial material.',
    'Confidence below 0.80 is not acceptable for formal inventory; if uncertain, still return your best partition with calibrated confidence.',
    `This is independent pass ${passKind}.`
  ].join(' ');
  const user = JSON.stringify({
    job: {
      page_identity_source_image_id: job.page_identity_source_image_id,
      source_ocr_json_sha256: job.source_ocr_json_sha256,
      block_count: job.block_count
    },
    blocks
  });
  return { system, user };
}

async function ensureConsensus(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin.rpc('build_source_page_article_inventory_consensus_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw new ReviewRequiredError(error.message);
  return data;
}

async function loadCandidates(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_consensus_groups_v1')
    .select('candidate_key,article_ordinal,headline_anchor,block_indices')
    .eq('job_id', jobId)
    .eq('group_kind', 'article')
    .order('article_ordinal', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    candidate_key: String(row.candidate_key),
    article_ordinal: Number(row.article_ordinal),
    headline_anchor: String(row.headline_anchor || ''),
    group_block_indices: Array.isArray(row.block_indices) ? row.block_indices.map(Number) : []
  })) as ArticleCandidate[];
}

async function loadFrozenArticles(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin
    .from('articles')
    .select('id,article_ordinal,title,body,source_month')
    .eq('source_image_id', job.page_identity_source_image_id)
    .eq('is_formal', true)
    .order('article_ordinal', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    article_id: String(row.id),
    article_ordinal: Number(row.article_ordinal),
    title: String(row.title || ''),
    body: String(row.body || ''),
    source_month: String(row.source_month || '')
  })) as FrozenArticle[];
}

async function tryAutoResolve(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin.rpc('resolve_inventory_mapping_auto_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw new ReviewRequiredError(error.message);
  return asRecord(data);
}

async function listMappingPassKinds(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_mapping_pass_runs_v2')
    .select('pass_kind')
    .eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((row) => String(row.pass_kind)));
}

async function buildMappingPrompt(job: ClaimedInventoryJob, candidates: ArticleCandidate[], articles: FrozenArticle[], passKind: MappingPassKind) {
  const blocks = await loadBlocks(job);
  const blockMap = new Map(blocks.map((block) => [block.block_index, block.block_text]));
  const candidatePayload = candidates.map((candidate) => ({
    candidate_key: candidate.candidate_key,
    article_ordinal: candidate.article_ordinal,
    headline_anchor: candidate.headline_anchor,
    ocr_text: candidate.group_block_indices.map((index) => blockMap.get(index) || '').join('\n').slice(0, 18000)
  }));
  const articlePayload = articles.map((article) => ({
    article_id: article.article_id,
    article_ordinal: article.article_ordinal,
    title: article.title,
    body: article.body.slice(0, 18000),
    source_month: article.source_month
  }));
  const system = [
    'You are an independent article identity mapper.',
    'Match each blind inventory candidate to exactly one frozen formal article and each frozen article to exactly one candidate.',
    'Use OCR text/headline evidence and frozen article title/body only.',
    'Do not infer from filenames, upload order, UUID shape, or prior mapping pass outputs.',
    'Return only confident one-to-one matches. Confidence below 0.80 is not acceptable.',
    `This is independent mapping pass ${passKind}.`
  ].join(' ');
  return { system, user: JSON.stringify({ candidates: candidatePayload, frozen_articles: articlePayload }) };
}

async function persistMappingPass(job: ClaimedInventoryJob, passKind: MappingPassKind, model: string, receipt: Awaited<ReturnType<typeof callStructured>>, mappings: MappingRow[]) {
  const { data, error } = await supabaseAdmin.rpc('record_source_page_article_inventory_mapping_pass_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_pass_kind: passKind,
    p_model: model,
    p_provider_response_id: receipt.providerResponseId,
    p_prompt_sha256: receipt.promptSha256,
    p_response_sha256: receipt.responseSha256,
    p_mappings: mappings
  });
  if (error) throw new Error(error.message);
  return data;
}

async function reconcileMapping(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin.rpc('reconcile_source_page_article_inventory_mapping_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw new ReviewRequiredError(error.message);
  return data;
}

async function finalize(job: ClaimedInventoryJob) {
  const { data, error } = await supabaseAdmin.rpc('finalize_source_page_article_inventory_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw new ReviewRequiredError(error.message);
  return data;
}

async function yieldJob(job: ClaimedInventoryJob, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_source_page_article_inventory_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_completed_stage: stage
  });
  if (error) throw new Error(error.message);
  return data;
}

async function failJob(job: ClaimedInventoryJob, message: string) {
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_message: message.slice(0, 2000)
  });
  if (error) throw new Error(`${message}; fail rpc: ${error.message}`);
  return data;
}

async function reviewJob(job: ClaimedInventoryJob, message: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_message: message.slice(0, 2000),
    p_review_attempt_limit: REVIEW_ATTEMPT_LIMIT
  });
  if (error) throw new Error(`${message}; review rpc: ${error.message}`);
  return data;
}

export async function runArticleInventoryWorkerStep(jobId?: string) {
  const job = await claimOneJob(jobId);
  if (!job) return { claimed: 0 };

  try {
    const mapperModel = process.env.OPENAI_INVENTORY_MAPPER_MODEL || VISION_MODEL;
    const criticModel = process.env.OPENAI_INVENTORY_CRITIC_MODEL || 'gpt-4o';
    const adjudicatorModel = process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL || 'gpt-4o-mini';
    const mappingMapperModel = process.env.OPENAI_INVENTORY_MAPPING_MAPPER_MODEL || TEXT_MODEL;
    const mappingCriticModel = process.env.OPENAI_INVENTORY_MAPPING_CRITIC_MODEL || 'gpt-4o';
    requireDistinctModels([mapperModel, criticModel], 'blind inventory');
    if (job.requires_third_pass) requireDistinctModels([mapperModel, criticModel, adjudicatorModel], 'blind inventory third pass');
    requireDistinctModels([mappingMapperModel, mappingCriticModel], 'article mapping');

    const blocks = await loadBlocks(job);
    const passKinds = await listPassKinds(job.id);
    if (!passKinds.has('mapper')) {
      const prompt = await buildBlindPrompt(job, blocks, 'mapper');
      const receipt = await callStructured({ model: mapperModel, ...prompt, schema: blindSchema });
      const groups = parseBlindGroups(receipt.parsed, blocks);
      await persistBlindPass(job, 'mapper', mapperModel, receipt, groups);
      return { claimed: 1, stage: 'blind_mapper', job_id: job.id, yield: await yieldJob(job, 'blind_mapper') };
    }
    if (!passKinds.has('critic')) {
      const prompt = await buildBlindPrompt(job, blocks, 'critic');
      const receipt = await callStructured({ model: criticModel, ...prompt, schema: blindSchema });
      const groups = parseBlindGroups(receipt.parsed, blocks);
      await persistBlindPass(job, 'critic', criticModel, receipt, groups);
      return { claimed: 1, stage: 'blind_critic', job_id: job.id, yield: await yieldJob(job, 'blind_critic') };
    }
    if (job.requires_third_pass && !passKinds.has('adjudicator')) {
      const prompt = await buildBlindPrompt(job, blocks, 'adjudicator');
      const receipt = await callStructured({ model: adjudicatorModel, ...prompt, schema: blindSchema });
      const groups = parseBlindGroups(receipt.parsed, blocks);
      await persistBlindPass(job, 'adjudicator', adjudicatorModel, receipt, groups);
      return { claimed: 1, stage: 'blind_adjudicator', job_id: job.id, yield: await yieldJob(job, 'blind_adjudicator') };
    }

    await ensureConsensus(job);
    const candidates = await loadCandidates(job.id);
    const articles = await loadFrozenArticles(job);
    if (candidates.length !== articles.length || candidates.length !== job.existing_article_count) {
      throw new ReviewRequiredError(`Consensus candidate count ${candidates.length} does not equal frozen article count ${articles.length}.`);
    }

    const auto = await tryAutoResolve(job);
    if (auto.status === 'resolved') {
      return { claimed: 1, stage: 'auto_map_finalize', job_id: job.id, result: await finalize(job) };
    }

    const mappingPassKinds = await listMappingPassKinds(job.id);
    if (!mappingPassKinds.has('mapper')) {
      const prompt = await buildMappingPrompt(job, candidates, articles, 'mapper');
      const receipt = await callStructured({ model: mappingMapperModel, ...prompt, schema: mappingSchema });
      const mappings = parseMappings(receipt.parsed, candidates, articles);
      await persistMappingPass(job, 'mapper', mappingMapperModel, receipt, mappings);
      return { claimed: 1, stage: 'mapping_mapper', job_id: job.id, yield: await yieldJob(job, 'mapping_mapper') };
    }
    if (!mappingPassKinds.has('critic')) {
      const prompt = await buildMappingPrompt(job, candidates, articles, 'critic');
      const receipt = await callStructured({ model: mappingCriticModel, ...prompt, schema: mappingSchema });
      const mappings = parseMappings(receipt.parsed, candidates, articles);
      await persistMappingPass(job, 'critic', mappingCriticModel, receipt, mappings);
      return { claimed: 1, stage: 'mapping_critic', job_id: job.id, yield: await yieldJob(job, 'mapping_critic') };
    }

    await reconcileMapping(job);
    return { claimed: 1, stage: 'mapping_finalize', job_id: job.id, result: await finalize(job) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown inventory worker error';
    if (error instanceof ReviewRequiredError) {
      return { claimed: 1, stage: 'review_required', job_id: job.id, error: message, result: await reviewJob(job, message) };
    }
    return { claimed: 1, stage: 'failed', job_id: job.id, error: message, result: await failJob(job, message) };
  }
}

export async function getArticleInventoryStatus() {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_gate_v1').select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

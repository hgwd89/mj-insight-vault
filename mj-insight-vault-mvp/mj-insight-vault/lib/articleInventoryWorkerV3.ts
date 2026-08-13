import { createHash } from 'node:crypto';
import { supabaseAdmin } from './supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL, VISION_MODEL } from './openai';

type JsonRecord = Record<string, unknown>;
type BlindPassKind = 'mapper' | 'critic' | 'adjudicator';
type MappingPassKind = 'mapper' | 'critic';

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

type InventoryGroup = {
  group_kind: 'article' | 'non_article';
  block_indices: number[];
  headline_anchor: string;
  non_article_role: string;
  confidence: number;
  reason: string;
};

type ConsensusGroup = {
  group_fingerprint: string;
  block_indices: number[];
  headline_anchor: string;
  group_text: string;
  selected_pass: string;
};

type FormalArticle = {
  article_id: string;
  headline: string;
  analysis_body_clean: string;
  analysis_body_clean_sha256: string;
  analysis_body_clean_version: string;
  article_date: string;
  source_image_id: string;
};

type MappingRow = {
  group_fingerprint: string;
  article_id: string;
  confidence: number;
  rationale: string;
};

class ReviewRequiredError extends Error {}

const LEASE_SECONDS = 240;
const CLEAN_BODY_VERSION = 'clean_article_analysis_body_v1';

const blindSchema = {
  name: 'blind_article_inventory_v3',
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
  name: 'inventory_article_mapping_v4_clean_body',
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

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object response.');
  return value as JsonRecord;
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== 'string') throw new Error(`Expected string: ${field}`);
  return value;
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected number: ${field}`);
  return value;
}

function arrayValue(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`Expected array: ${field}`);
  return value;
}

function requireDistinctModels(models: string[], label: string) {
  if (new Set(models).size !== models.length) throw new ReviewRequiredError(`${label}: distinct models required`);
}

function outputText(payload: JsonRecord) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text;
  for (const rawItem of Array.isArray(payload.output) ? payload.output : []) {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as JsonRecord : {};
    for (const rawPart of Array.isArray(item.content) ? item.content : []) {
      const part = rawPart && typeof rawPart === 'object' ? rawPart as JsonRecord : {};
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

  let payload: JsonRecord;
  try { payload = JSON.parse(raw) as JsonRecord; }
  catch { throw new Error('OpenAI structured response envelope is not valid JSON.'); }
  if (payload.status === 'incomplete') {
    throw new Error(`OpenAI incomplete structured response: ${JSON.stringify(payload.incomplete_details || {})}`);
  }

  const providerResponseId = stringValue(payload.id, 'response.id');
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('Invalid provider response receipt.');
  let parsed: JsonRecord;
  try { parsed = JSON.parse(outputText(payload)) as JsonRecord; }
  catch { throw new Error('OpenAI structured output JSON parse failed.'); }
  return { parsed, providerResponseId, promptSha256, responseSha256: sha256(raw) };
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

async function passKinds(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_pass_runs_v1').select('pass_kind').eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((row) => String(row.pass_kind)));
}

function parseBlindGroups(parsed: JsonRecord, blocks: OcrBlock[]) {
  const blockMap = new Map(blocks.map((b) => [b.block_index, b]));
  const seen = new Set<number>();
  const groups = arrayValue(parsed.groups, 'groups').map((raw, index) => {
    const item = record(raw);
    const kind = stringValue(item.group_kind, `groups[${index}].group_kind`);
    if (kind !== 'article' && kind !== 'non_article') throw new ReviewRequiredError('Invalid group kind.');
    const indices = arrayValue(item.block_indices, 'block_indices').map((v) => {
      const n = numberValue(v, 'block_index');
      if (!Number.isInteger(n) || !blockMap.has(n) || seen.has(n)) throw new ReviewRequiredError(`Invalid or duplicate block ${n}.`);
      seen.add(n);
      return n;
    });
    const headline = stringValue(item.headline_anchor, 'headline_anchor').trim();
    const role = stringValue(item.non_article_role, 'non_article_role').trim();
    const confidence = numberValue(item.confidence, 'confidence');
    const reason = stringValue(item.reason, 'reason').trim();
    if (confidence < 0.8) throw new ReviewRequiredError(`Low confidence group ${confidence}.`);
    if (kind === 'article') {
      if (!headline) throw new ReviewRequiredError('Article headline anchor missing.');
      if (!indices.some((i) => (blockMap.get(i)?.block_text || '').toLowerCase().includes(headline.toLowerCase()))) {
        throw new ReviewRequiredError('Article headline anchor is not a verbatim OCR substring.');
      }
    } else if (!role) {
      throw new ReviewRequiredError('Non-article role missing.');
    }
    return {
      group_kind: kind,
      block_indices: indices,
      headline_anchor: kind === 'article' ? headline : '',
      non_article_role: kind === 'non_article' ? role : '',
      confidence,
      reason
    } as InventoryGroup;
  });
  if (seen.size !== blocks.length) throw new ReviewRequiredError('Blind pass did not partition every OCR block exactly once.');
  return groups;
}

function blindPrompt(job: ClaimedJob, blocks: OcrBlock[], passKind: BlindPassKind) {
  return {
    system: [
      'You are a blind page-level article inventory auditor.',
      'Use only the OCR blocks supplied in this request.',
      'Do not use filenames, database article counts, existing article records, or prior pass outputs.',
      'Partition every OCR block exactly once into article or non_article groups.',
      'An article group is one distinct editorial article. A subsection or subheading inside an article is not a new article.',
      'Advertisements, advertorial-looking promotional material, mastheads, folios, navigation and decorative text must be non_article unless the OCR itself clearly supports a standalone editorial article.',
      'For article groups, headline_anchor must be a short verbatim substring copied exactly from one of that group’s OCR blocks; non_article_role must be empty.',
      'For non_article groups, headline_anchor must be empty and non_article_role must be specific.',
      'Return confidence below 0.80 if the partition is genuinely uncertain; do not force certainty.',
      `This is independent blind pass ${passKind}.`
    ].join(' '),
    user: JSON.stringify({
      page_identity_source_image_id: job.page_identity_source_image_id,
      source_ocr_json_sha256: job.source_ocr_json_sha256,
      blocks
    })
  };
}

async function persistBlind(job: ClaimedJob, passKind: BlindPassKind, model: string, receipt: Awaited<ReturnType<typeof callStructured>>, groups: InventoryGroup[]) {
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

async function consensusSource(jobId: string) {
  const { data, error } = await supabaseAdmin.rpc('inventory_consensus_source_v3', { p_job_id: jobId });
  if (error) throw new Error(error.message);
  return typeof data === 'string' ? data : null;
}

async function loadConsensusGroups(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_consensus_groups_v3')
    .select('group_fingerprint,block_indices,headline_anchor,group_text,selected_pass')
    .eq('job_id', jobId)
    .order('group_fingerprint', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    group_fingerprint: String(row.group_fingerprint),
    block_indices: Array.isArray(row.block_indices) ? row.block_indices.map(Number) : [],
    headline_anchor: String(row.headline_anchor || ''),
    group_text: String(row.group_text || ''),
    selected_pass: String(row.selected_pass || '')
  })) as ConsensusGroup[];
}

async function loadFormalArticles(job: ClaimedJob) {
  const { data: maps, error: mapError } = await supabaseAdmin
    .from('source_page_capture_map_v1')
    .select('source_image_id')
    .eq('page_identity_source_image_id', job.page_identity_source_image_id);
  if (mapError) throw new Error(mapError.message);
  const sourceIds = [...new Set((maps || []).map((row) => String(row.source_image_id)))];
  if (!sourceIds.length) throw new ReviewRequiredError('No source captures for page identity.');

  const { data: formalRows, error: formalError } = await supabaseAdmin
    .from('formal_corpus_articles_v1')
    .select('id,headline,article_date,source_image_id')
    .in('source_image_id', sourceIds);
  if (formalError) throw new Error(formalError.message);
  const formalById = new Map<string, { headline: string; article_date: string; source_image_id: string }>();
  for (const row of formalRows || []) {
    const id = String(row.id);
    if (!formalById.has(id)) formalById.set(id, {
      headline: String(row.headline || ''),
      article_date: String(row.article_date || ''),
      source_image_id: String(row.source_image_id || '')
    });
  }
  const ids = [...formalById.keys()];
  if (!ids.length) throw new ReviewRequiredError('No formal articles for page identity.');

  const { data: cleanRows, error: cleanError } = await supabaseAdmin
    .from('articles')
    .select('id,analysis_body_clean,analysis_body_clean_sha256,analysis_body_clean_version')
    .in('id', ids);
  if (cleanError) throw new Error(cleanError.message);
  const cleanById = new Map((cleanRows || []).map((row) => [String(row.id), row]));

  const articles: FormalArticle[] = [];
  for (const [articleId, formal] of formalById) {
    const clean = cleanById.get(articleId);
    const body = String(clean?.analysis_body_clean || '');
    const bodySha = String(clean?.analysis_body_clean_sha256 || '');
    const bodyVersion = String(clean?.analysis_body_clean_version || '');
    if (body.trim().length < 40 || bodyVersion !== CLEAN_BODY_VERSION || !/^[0-9a-f]{64}$/.test(bodySha) || sha256(body) !== bodySha) {
      throw new ReviewRequiredError(`Formal article clean-body provenance invalid: ${articleId}`);
    }
    articles.push({
      article_id: articleId,
      headline: formal.headline,
      analysis_body_clean: body,
      analysis_body_clean_sha256: bodySha,
      analysis_body_clean_version: bodyVersion,
      article_date: formal.article_date,
      source_image_id: formal.source_image_id
    });
  }
  return articles;
}

async function tryAutoMap(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.rpc('resolve_inventory_mapping_auto_v3', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw new Error(error.message);
  return record(data);
}

async function mappingPassKinds(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_mapping_pass_runs_v2').select('pass_kind').eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((row) => String(row.pass_kind)));
}

function mappingPrompt(groups: ConsensusGroup[], articles: FormalArticle[], passKind: MappingPassKind) {
  return {
    system: [
      'You are an independent one-to-one article identity mapper.',
      'Match every blind consensus group to exactly one formal article, and every supplied formal article to exactly one group.',
      'Use only the group OCR evidence, formal headline, and article-specific clean analysis body supplied here.',
      'The formal clean body is article-specific evidence. Do not infer identity from UUID shape, ordering, filenames, or prior mapping outputs.',
      'Each mapping confidence must be at least 0.80; if that cannot be supported, return your best mapping with calibrated lower confidence so the caller fails closed.',
      `This is independent mapping pass ${passKind}.`
    ].join(' '),
    user: JSON.stringify({
      groups: groups.map((g) => ({
        group_fingerprint: g.group_fingerprint,
        headline_anchor: g.headline_anchor,
        ocr_text: g.group_text.slice(0, 18000)
      })),
      formal_articles: articles.map((a) => ({
        article_id: a.article_id,
        headline: a.headline,
        analysis_body_clean: a.analysis_body_clean.slice(0, 18000),
        analysis_body_clean_sha256: a.analysis_body_clean_sha256,
        analysis_body_clean_version: a.analysis_body_clean_version,
        article_date: a.article_date
      }))
    })
  };
}

function parseMappings(parsed: JsonRecord, groups: ConsensusGroup[], articles: FormalArticle[]) {
  const allowedGroups = new Set(groups.map((g) => g.group_fingerprint));
  const allowedArticles = new Set(articles.map((a) => a.article_id));
  const seenGroups = new Set<string>();
  const seenArticles = new Set<string>();
  const rows = arrayValue(parsed.mappings, 'mappings').map((raw, index) => {
    const item = record(raw);
    const groupFingerprint = stringValue(item.group_fingerprint, `mappings[${index}].group_fingerprint`);
    const articleId = stringValue(item.article_id, `mappings[${index}].article_id`);
    const confidence = numberValue(item.confidence, `mappings[${index}].confidence`);
    const rationale = stringValue(item.rationale, `mappings[${index}].rationale`).trim();
    if (!allowedGroups.has(groupFingerprint) || !allowedArticles.has(articleId)) throw new ReviewRequiredError('Mapping referenced unknown identity.');
    if (seenGroups.has(groupFingerprint) || seenArticles.has(articleId)) throw new ReviewRequiredError('Mapping is not bijective.');
    if (confidence < 0.8) throw new ReviewRequiredError(`Low-confidence mapping ${confidence}.`);
    seenGroups.add(groupFingerprint);
    seenArticles.add(articleId);
    return { group_fingerprint: groupFingerprint, article_id: articleId, confidence, rationale } as MappingRow;
  });
  if (rows.length !== groups.length || rows.length !== articles.length) throw new ReviewRequiredError('Mapping did not cover full bijection.');
  return rows;
}

async function persistMapping(job: ClaimedJob, passKind: MappingPassKind, model: string, receipt: Awaited<ReturnType<typeof callStructured>>, mappings: MappingRow[]) {
  const { data, error } = await supabaseAdmin.rpc('replace_inventory_mapping_pass_v3', {
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

async function finalize(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.rpc('finalize_source_page_article_inventory_job_v3', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw new ReviewRequiredError(error.message);
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

export async function runArticleInventoryWorkerV3Step(jobId?: string) {
  const job = await claim(jobId);
  if (!job) return { claimed: 0, job_id: jobId || null };
  try {
    const mapperModel = process.env.OPENAI_INVENTORY_MAPPER_MODEL || VISION_MODEL;
    const criticModel = process.env.OPENAI_INVENTORY_CRITIC_MODEL || 'gpt-4o';
    const adjudicatorModel = process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL || 'gpt-4o-mini';
    const mappingMapperModel = process.env.OPENAI_INVENTORY_MAPPING_MAPPER_MODEL || TEXT_MODEL;
    const mappingCriticModel = process.env.OPENAI_INVENTORY_MAPPING_CRITIC_MODEL || 'gpt-4o';
    requireDistinctModels([mapperModel, criticModel], 'blind inventory');
    if (job.requires_third_pass) requireDistinctModels([mapperModel, criticModel, adjudicatorModel], 'blind adjudication');
    requireDistinctModels([mappingMapperModel, mappingCriticModel], 'article mapping');

    const blocks = await loadBlocks(job);
    const existingPasses = await passKinds(job.id);
    if (!existingPasses.has('mapper')) {
      const prompt = blindPrompt(job, blocks, 'mapper');
      const receipt = await callStructured({ model: mapperModel, ...prompt, schema: blindSchema });
      await persistBlind(job, 'mapper', mapperModel, receipt, parseBlindGroups(receipt.parsed, blocks));
      return { claimed: 1, job_id: job.id, stage: 'blind_mapper_v3', yield: await yieldJob(job, 'blind_mapper_v3') };
    }
    if (!existingPasses.has('critic')) {
      const prompt = blindPrompt(job, blocks, 'critic');
      const receipt = await callStructured({ model: criticModel, ...prompt, schema: blindSchema });
      await persistBlind(job, 'critic', criticModel, receipt, parseBlindGroups(receipt.parsed, blocks));
      return { claimed: 1, job_id: job.id, stage: 'blind_critic_v3', yield: await yieldJob(job, 'blind_critic_v3') };
    }
    if (job.requires_third_pass && !existingPasses.has('adjudicator')) {
      const prompt = blindPrompt(job, blocks, 'adjudicator');
      const receipt = await callStructured({ model: adjudicatorModel, ...prompt, schema: blindSchema });
      await persistBlind(job, 'adjudicator', adjudicatorModel, receipt, parseBlindGroups(receipt.parsed, blocks));
      return { claimed: 1, job_id: job.id, stage: 'blind_adjudicator_v3', yield: await yieldJob(job, 'blind_adjudicator_v3') };
    }

    const source = await consensusSource(job.id);
    if (!source) return { claimed: 1, job_id: job.id, stage: 'consensus_review_v3', result: await finalize(job) };

    const groups = await loadConsensusGroups(job.id);
    const articles = await loadFormalArticles(job);
    if (groups.length !== job.existing_article_count || articles.length !== job.existing_article_count) {
      return { claimed: 1, job_id: job.id, stage: 'count_resolution_v3', consensus_source: source, result: await finalize(job) };
    }

    const auto = await tryAutoMap(job);
    if (String(auto.status) === 'resolved') {
      return { claimed: 1, job_id: job.id, stage: 'auto_map_finalize_v3', consensus_source: source, result: await finalize(job) };
    }

    const mapPasses = await mappingPassKinds(job.id);
    if (!mapPasses.has('mapper')) {
      const prompt = mappingPrompt(groups, articles, 'mapper');
      const receipt = await callStructured({ model: mappingMapperModel, ...prompt, schema: mappingSchema });
      await persistMapping(job, 'mapper', mappingMapperModel, receipt, parseMappings(receipt.parsed, groups, articles));
      return { claimed: 1, job_id: job.id, stage: 'mapping_mapper_v4_clean_body', yield: await yieldJob(job, 'mapping_mapper_v4_clean_body') };
    }
    if (!mapPasses.has('critic')) {
      const prompt = mappingPrompt(groups, articles, 'critic');
      const receipt = await callStructured({ model: mappingCriticModel, ...prompt, schema: mappingSchema });
      await persistMapping(job, 'critic', mappingCriticModel, receipt, parseMappings(receipt.parsed, groups, articles));
      return { claimed: 1, job_id: job.id, stage: 'mapping_critic_v4_clean_body', yield: await yieldJob(job, 'mapping_critic_v4_clean_body') };
    }

    return { claimed: 1, job_id: job.id, stage: 'mapping_finalize_v4_clean_body', consensus_source: source, result: await finalize(job) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown inventory v3 error';
    if (error instanceof ReviewRequiredError) {
      return { claimed: 1, job_id: job.id, stage: 'review_required_v3', error: message, result: await reviewJob(job, message) };
    }
    return { claimed: 1, job_id: job.id, stage: 'failed_v3', error: message, result: await failJob(job, message) };
  }
}

export async function getArticleInventoryV3Status() {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_gate_v1').select('*').single();
  if (error) throw new Error(error.message);
  return { ...(data || {}), worker_version: 'article_inventory_worker_v3_clean_body_mapping' };
}

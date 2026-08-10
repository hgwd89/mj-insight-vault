import { createHash, timingSafeEqual } from 'node:crypto';
import { getOpenAIKey } from '@/lib/openai';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BUILDCHECK_BRANCH = 'audit/verified-pipeline-v10-buildcheck';
const EXPECTED_NONCE_SHA256 = 'a1a9193f8477327115f6b89946de7898280e61bcb867ec9d2c8d69168b8feecd';
const LEASE_SECONDS = 420;

type JsonRecord = Record<string, unknown>;
type PassKind = 'mapper' | 'critic';

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

class PassValidationError extends Error {
  constructor(
    message: string,
    readonly kind: 'structural' | 'low_confidence'
  ) {
    super(message);
  }
}

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

function authorized(req: Request) {
  if (process.env.VERCEL_ENV !== 'preview') return false;
  if (process.env.VERCEL_GIT_COMMIT_REF !== BUILDCHECK_BRANCH) return false;
  const nonce = new URL(req.url).searchParams.get('nonce') || '';
  const actual = createHash('sha256').update(nonce).digest();
  const expected = Buffer.from(EXPECTED_NONCE_SHA256, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object response.');
  return value as JsonRecord;
}

function asArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new PassValidationError(`Expected array: ${field}`, 'structural');
  return value;
}

function asString(value: unknown, field: string) {
  if (typeof value !== 'string') throw new PassValidationError(`Expected string: ${field}`, 'structural');
  return value;
}

function asNumber(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PassValidationError(`Expected finite number: ${field}`, 'structural');
  }
  return value;
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

async function callStructured(args: { model: string; system: string; user: string }) {
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
    text: { format: { type: 'json_schema', ...blindSchema } }
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
  const providerResponseId = typeof payload.id === 'string' ? payload.id : '';
  if (!/^resp_[A-Za-z0-9_-]{16,}$/.test(providerResponseId)) throw new Error('OpenAI response id is not a real provider receipt.');
  const outputText = responseOutputText(payload);
  return {
    parsed: JSON.parse(outputText) as JsonRecord,
    providerResponseId,
    promptSha256,
    responseSha256: sha256(raw)
  };
}

function parseGroups(parsed: JsonRecord, blocks: OcrBlock[]) {
  const rows = asArray(parsed.groups, 'groups');
  if (rows.length === 0) throw new PassValidationError('Blind inventory returned zero groups.', 'structural');
  const blockMap = new Map(blocks.map((block) => [block.block_index, block]));
  const seen = new Set<number>();
  const groups: InventoryGroup[] = rows.map((raw, index) => {
    const item = asRecord(raw);
    const groupKind = asString(item.group_kind, `groups[${index}].group_kind`);
    if (groupKind !== 'article' && groupKind !== 'non_article') {
      throw new PassValidationError(`Invalid group_kind at groups[${index}]`, 'structural');
    }
    const indices = asArray(item.block_indices, `groups[${index}].block_indices`).map((rawIndex) => {
      const blockIndex = asNumber(rawIndex, `groups[${index}].block_indices`);
      if (!Number.isInteger(blockIndex)) throw new PassValidationError('block_index must be integer.', 'structural');
      if (!blockMap.has(blockIndex)) throw new PassValidationError(`Unknown block index ${blockIndex}.`, 'structural');
      if (seen.has(blockIndex)) throw new PassValidationError(`Block ${blockIndex} was assigned more than once.`, 'structural');
      seen.add(blockIndex);
      return blockIndex;
    });
    if (indices.length === 0) throw new PassValidationError(`Empty block_indices at groups[${index}]`, 'structural');

    const headlineAnchor = asString(item.headline_anchor, `groups[${index}].headline_anchor`).trim();
    const nonArticleRole = asString(item.non_article_role, `groups[${index}].non_article_role`).trim();
    const confidence = asNumber(item.confidence, `groups[${index}].confidence`);
    const reason = asString(item.reason, `groups[${index}].reason`).trim();
    if (confidence < 0.8) {
      throw new PassValidationError(`Low-confidence blind inventory group: ${confidence}.`, 'low_confidence');
    }
    if (groupKind === 'article') {
      if (!headlineAnchor) throw new PassValidationError('Article group missing headline_anchor.', 'structural');
      const normalizedAnchor = headlineAnchor.replace(/\s+/g, '').toLowerCase();
      const anchorPresent = indices.some((blockIndex) =>
        (blockMap.get(blockIndex)?.block_text || '').replace(/\s+/g, '').toLowerCase().includes(normalizedAnchor)
      );
      if (!anchorPresent) throw new PassValidationError('Article headline_anchor is not present in its OCR blocks.', 'structural');
    } else if (!nonArticleRole) {
      throw new PassValidationError('Non-article group missing non_article_role.', 'structural');
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
    throw new PassValidationError(`Blind inventory omitted blocks: ${missing.join(',')}`, 'structural');
  }
  return groups;
}

function promptFor(job: ClaimedJob, blocks: OcrBlock[], passKind: PassKind, repairReason?: string) {
  const system = [
    'You are a blind page-level article inventory auditor.',
    'Use only the OCR blocks supplied in this request.',
    'Do not use filenames, upload metadata, frozen article records, article counts, or outputs from another audit pass.',
    'Partition EVERY expected OCR block exactly once into article or non_article groups.',
    'Before returning, verify that the union of block_indices equals expected_block_indices exactly and that no block appears twice.',
    'Article groups must represent distinct editorial articles and include a verbatim headline substring from one of their own OCR blocks.',
    'Non-article groups include mastheads, folios, page labels, ads, navigation, decorative text, captions not belonging to an article, and other non-editorial material.',
    'Confidence is epistemic. Do not inflate it. If genuinely uncertain, report calibrated confidence; the pipeline will route confidence below 0.80 to review.',
    `This is independent blind pass ${passKind}.`,
    repairReason ? `Your immediately previous response for THIS SAME pass failed only structural validation: ${repairReason}. Return a corrected fresh partition without changing confidence merely to pass validation.` : ''
  ].filter(Boolean).join(' ');
  const user = JSON.stringify({
    page_identity_source_image_id: job.page_identity_source_image_id,
    source_ocr_json_sha256: job.source_ocr_json_sha256,
    block_count: job.block_count,
    expected_block_indices: blocks.map((block) => block.block_index),
    blocks
  });
  return { system, user };
}

async function runPass(job: ClaimedJob, blocks: OcrBlock[], passKind: PassKind, model: string) {
  const firstPrompt = promptFor(job, blocks, passKind);
  let receipt = await callStructured({ model, ...firstPrompt });
  try {
    return { receipt, groups: parseGroups(receipt.parsed, blocks), repaired: false };
  } catch (error) {
    if (!(error instanceof PassValidationError)) throw error;
    if (error.kind === 'low_confidence') throw error;
    const repairPrompt = promptFor(job, blocks, passKind, error.message);
    receipt = await callStructured({ model, ...repairPrompt });
    try {
      return { receipt, groups: parseGroups(receipt.parsed, blocks), repaired: true };
    } catch (repairError) {
      if (repairError instanceof PassValidationError && repairError.kind === 'structural') {
        throw new PassValidationError(`Exhausted repair attempt: ${repairError.message}`, 'structural');
      }
      throw repairError;
    }
  }
}

async function claimJob(jobId: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_smoke_v1', {
    p_job_id: jobId,
    p_lease_seconds: LEASE_SECONDS
  });
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data[0] : data) || null) as ClaimedJob | null;
}

async function renewLease(job: ClaimedJob) {
  const { error } = await supabaseAdmin.rpc('renew_source_page_article_inventory_job_lease_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_lease_seconds: LEASE_SECONDS
  });
  if (error) throw new Error(error.message);
}

async function loadBlocks(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin
    .from('source_ocr_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,ocr_confidence,source_ocr_json_sha256')
    .eq('source_image_id', job.inventory_source_image_id)
    .eq('page_index', 0)
    .eq('source_ocr_json_sha256', job.source_ocr_json_sha256)
    .order('block_index', { ascending: true });
  if (error) throw new Error(error.message);
  const blocks = (data || []) as OcrBlock[];
  if (blocks.length !== job.block_count) throw new Error(`Inventory block count mismatch: ${blocks.length} != ${job.block_count}.`);
  return blocks;
}

async function existingPassKinds(jobId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_page_article_inventory_pass_runs_v1')
    .select('pass_kind')
    .eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((row) => String(row.pass_kind)));
}

async function persistPass(job: ClaimedJob, passKind: PassKind, model: string, result: Awaited<ReturnType<typeof runPass>>) {
  const { data, error } = await supabaseAdmin.rpc('replace_source_page_article_inventory_pass_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_pass_kind: passKind,
    p_model: model,
    p_provider_response_id: result.receipt.providerResponseId,
    p_prompt_sha256: result.receipt.promptSha256,
    p_response_sha256: result.receipt.responseSha256,
    p_groups: result.groups
  });
  if (error) throw new Error(error.message);
  return data;
}

async function reviewJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_reason: reason.slice(0, 2000)
  });
  if (error) throw new Error(error.message);
  return data;
}

async function failRunningJob(job: ClaimedJob, message: string) {
  const { data: state } = await supabaseAdmin
    .from('source_page_article_inventory_jobs_v1')
    .select('status,lease_token')
    .eq('id', job.id)
    .maybeSingle();
  if (state?.status !== 'running' || state?.lease_token !== job.lease_token) return state;
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error_message: message.slice(0, 2000),
    p_retryable: true
  });
  if (error) throw new Error(`${message}; fail rpc: ${error.message}`);
  return data;
}

async function finalizeJob(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.rpc('finalize_source_page_article_inventory_job_v1', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw new Error(error.message);
  return data as JsonRecord;
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response('Not Found', { status: 404 });
  const jobId = new URL(req.url).searchParams.get('job_id')?.trim() || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return Response.json({ error: 'valid job_id is required' }, { status: 400 });
  }

  const job = await claimJob(jobId);
  if (!job) return Response.json({ claimed: 0, job_id: jobId }, { headers: { 'cache-control': 'no-store' } });

  try {
    if (job.requires_third_pass) {
      const result = await reviewJob(job, 'current-contract smoke route is restricted to non-third-pass jobs');
      return Response.json({ claimed: 1, job_id: job.id, status: 'needs_review', stage: 'third_pass_not_smoked', result }, { headers: { 'cache-control': 'no-store' } });
    }

    const mapperModel = process.env.OPENAI_INVENTORY_MAPPER_MODEL || 'gpt-4.1';
    const criticModel = process.env.OPENAI_INVENTORY_CRITIC_MODEL || 'gpt-4o';
    if (mapperModel === criticModel) throw new Error('blind inventory requires distinct mapper and critic models');

    const blocks = await loadBlocks(job);
    const passKinds = await existingPassKinds(job.id);
    const executed: Array<{ pass_kind: PassKind; model: string; repaired: boolean }> = [];

    for (const [passKind, model] of [['mapper', mapperModel], ['critic', criticModel]] as const) {
      if (passKinds.has(passKind)) continue;
      await renewLease(job);
      let result: Awaited<ReturnType<typeof runPass>>;
      try {
        result = await runPass(job, blocks, passKind, model);
      } catch (error) {
        if (error instanceof PassValidationError) {
          const review = await reviewJob(job, `${passKind}: ${error.message}`);
          return Response.json({
            claimed: 1,
            job_id: job.id,
            status: 'needs_review',
            stage: `blind_${passKind}`,
            reason_class: error.kind,
            reason: error.message,
            review,
            executed
          }, { headers: { 'cache-control': 'no-store' } });
        }
        throw error;
      }
      await persistPass(job, passKind, model, result);
      executed.push({ pass_kind: passKind, model, repaired: result.repaired });
      passKinds.add(passKind);
    }

    await renewLease(job);
    const final = await finalizeJob(job);
    return Response.json({
      claimed: 1,
      job_id: job.id,
      stage: 'finalize',
      status: typeof final.status === 'string' ? final.status : 'unknown',
      final,
      executed
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown inventory smoke error';
    let cleanup: unknown = null;
    try {
      cleanup = await failRunningJob(job, message);
    } catch (cleanupError) {
      cleanup = { error: cleanupError instanceof Error ? cleanupError.message : 'cleanup failed' };
    }
    return Response.json({ claimed: 1, job_id: job.id, status: 'error', error: message, cleanup }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

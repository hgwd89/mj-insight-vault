import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;
type ClassificationPassKind = 'classifier' | 'critic';

class StructuralOutputError extends Error {}

const CALL_TIMEOUT_MS = 150_000;

const CLASSIFICATION_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'mj_verified_article_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'classification_status', 'primary_category', 'memberships', 'consumer_scene', 'market_signal',
      'product_type', 'consumer_need', 'confidence', 'reason', 'source_anchor'
    ],
    properties: {
      classification_status: { type: 'string', enum: ['categorized', 'no_matching_category'] },
      primary_category: { type: 'string' },
      memberships: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['category_id', 'score', 'confidence', 'source_anchor', 'reason'],
          properties: {
            category_id: { type: 'string' },
            score: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            source_anchor: { type: 'string' },
            reason: { type: 'string' }
          }
        }
      },
      consumer_scene: { type: 'string' },
      market_signal: { type: 'string' },
      product_type: { type: 'string' },
      consumer_need: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
      source_anchor: { type: 'string' }
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
  return text(error) || 'verified article classification worker failed';
}

function extractResponseText(responseJson: unknown) {
  const json = responseJson as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  const parts: string[] = [];
  for (const item of json.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string' && content.text.trim()) parts.push(content.text.trim());
    }
  }
  return parts.join('\n').trim();
}

function classificationModels() {
  const classifier = process.env.OPENAI_CLASSIFICATION_CLASSIFIER_MODEL?.trim() || TEXT_MODEL;
  const fallbackCritic = classifier === 'gpt-4o' ? 'gpt-4.1' : 'gpt-4o';
  const critic = process.env.OPENAI_CLASSIFICATION_CRITIC_MODEL?.trim() || fallbackCritic;
  if (!classifier || !critic || classifier === critic) {
    throw new Error('Classification classifier and critic models must be configured and distinct.');
  }
  return { classifier, critic };
}

function instructions(passKind: ClassificationPassKind) {
  const role = passKind === 'classifier'
    ? 'You are the first independent category classifier for a verified newspaper article.'
    : 'You are an independent second category critic. Do not assume another classifier exists.';
  return [
    role,
    'Use only the supplied verified crop OCR article text and the supplied category catalog.',
    'Do not invent categories and do not use outside knowledge to override the article text.',
    'An article may belong to multiple categories when the text contains direct, material evidence for each one.',
    'Every source_anchor must be an exact contiguous substring copied from verified_crop_ocr_text and should be specific enough to support the classification.',
    'Use no_matching_category when the catalog does not fit with adequate evidence. In that case primary_category must be empty and memberships must be empty.',
    'For categorized output, primary_category must appear in memberships.',
    'Membership confidence below 0.70 is not adequate evidence; omit that membership instead of forcing it.',
    'Keep consumer_scene, market_signal, product_type, and consumer_need concise and grounded in the article. Use an empty string when not supported.',
    'If the overall classification is uncertain, lower confidence rather than forcing certainty. The pipeline will route disagreement or low confidence to review.',
    'Return only the requested JSON.'
  ].join('\n');
}

function userText(input: { articleId: string; verifiedText: string; catalog: unknown }) {
  return JSON.stringify({
    task: 'verified_ocr_article_category_classification',
    article_id: input.articleId,
    verified_crop_ocr_text: input.verifiedText,
    category_catalog: input.catalog
  });
}

async function callResponsesJson(input: { model: string; instructions: string; userText: string }) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const promptSha = sha256([input.model, input.instructions, input.userText].join('\n---\n'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        store: false,
        max_output_tokens: 3000,
        instructions: input.instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: input.userText }] }],
        text: { format: CLASSIFICATION_RESPONSE_FORMAT }
      })
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`OpenAI Responses API failed: ${res.status} ${res.statusText} ${raw.slice(0, 2000)}`);
    const responseJson = JSON.parse(raw) as JsonRecord;
    const providerResponseId = text(responseJson.id);
    const outputText = extractResponseText(responseJson);
    if (!providerResponseId || !outputText) throw new Error('OpenAI classification receipt or output_text is missing.');
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

function parseResult(value: unknown, catalogIds: Set<string>) {
  if (!isRecord(value)) throw new StructuralOutputError('classification result is not an object');
  const status = text(value.classification_status);
  const primary = text(value.primary_category);
  const confidence = Number(value.confidence);
  const reason = text(value.reason);
  const sourceAnchor = text(value.source_anchor);
  if (!['categorized', 'no_matching_category'].includes(status)) throw new StructuralOutputError('classification status is invalid');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new StructuralOutputError('classification confidence is invalid');
  if (!reason) throw new StructuralOutputError('classification reason is missing');
  if (!Array.isArray(value.memberships)) throw new StructuralOutputError('classification memberships are missing');
  const seen = new Set<string>();
  const memberships = value.memberships.map((raw) => {
    if (!isRecord(raw)) throw new StructuralOutputError('classification membership is not an object');
    const categoryId = text(raw.category_id);
    const score = Number(raw.score);
    const memberConfidence = Number(raw.confidence);
    const anchor = text(raw.source_anchor);
    const memberReason = text(raw.reason);
    if (!catalogIds.has(categoryId) || seen.has(categoryId)) throw new StructuralOutputError('classification membership category is invalid or duplicated');
    if (!Number.isFinite(score) || score < 0 || score > 1 || !Number.isFinite(memberConfidence) || memberConfidence < 0 || memberConfidence > 1) {
      throw new StructuralOutputError('classification membership score or confidence is invalid');
    }
    if (!anchor || !memberReason) throw new StructuralOutputError('classification membership evidence is incomplete');
    seen.add(categoryId);
    return { category_id: categoryId, score, confidence: memberConfidence, source_anchor: anchor, reason: memberReason.slice(0, 1000) };
  });
  if (status === 'no_matching_category') {
    if (primary || memberships.length) throw new StructuralOutputError('no_matching_category must have no primary category or memberships');
  } else {
    if (!catalogIds.has(primary) || !seen.has(primary) || !sourceAnchor) throw new StructuralOutputError('categorized result has invalid primary category or source anchor');
  }
  return {
    classification_status: status,
    primary_category: primary,
    memberships,
    consumer_scene: text(value.consumer_scene).slice(0, 500),
    market_signal: text(value.market_signal).slice(0, 500),
    product_type: text(value.product_type).slice(0, 500),
    consumer_need: text(value.consumer_need).slice(0, 500),
    confidence,
    reason: reason.slice(0, 1500),
    source_anchor: sourceAnchor
  };
}

async function enqueueJobs() {
  const { data, error } = await supabaseAdmin.rpc('enqueue_article_classification_jobs_v6');
  if (error) {
    if (errorMessage(error).includes('classification_v6_duplicate_gate_required')) return { blocked: true as const, enqueued: 0 };
    throw error;
  }
  return { blocked: false as const, enqueued: Number(data || 0) };
}

async function claimOneJob() {
  const { data, error } = await supabaseAdmin.rpc('claim_article_classification_job_v6', { p_lease_seconds: 240 });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job = {
    id: text(row.id),
    articleId: text(row.article_id),
    passKind: text(row.active_pass_kind) as ClassificationPassKind,
    leaseToken: text(row.lease_token)
  };
  if (!job.id || !job.articleId || !job.leaseToken || !['classifier', 'critic'].includes(job.passKind)) throw new Error('Invalid claimed classification job.');
  return job;
}

async function getInput(job: Awaited<ReturnType<typeof claimOneJob>>) {
  if (!job) throw new Error('Classification job is missing.');
  const { data, error } = await supabaseAdmin.rpc('get_article_classification_input_v6', { p_job_id: job.id, p_lease_token: job.leaseToken });
  if (error) throw error;
  if (!isRecord(data) || !Array.isArray(data.category_catalog)) throw new StructuralOutputError('classification input is malformed');
  const verifiedText = text(data.verified_crop_ocr_text);
  if (!verifiedText) throw new StructuralOutputError('verified crop OCR classification text is missing');
  const catalog = data.category_catalog;
  const ids = new Set<string>();
  for (const item of catalog) {
    if (!isRecord(item) || !text(item.id)) throw new StructuralOutputError('category catalog row is malformed');
    ids.add(text(item.id));
  }
  if (!ids.size) throw new StructuralOutputError('category catalog is empty');
  return { verifiedText, catalog, catalogIds: ids };
}

async function storePass(job: NonNullable<Awaited<ReturnType<typeof claimOneJob>>>, model: string, receipt: Awaited<ReturnType<typeof callResponsesJson>>, result: ReturnType<typeof parseResult>) {
  const { data, error } = await supabaseAdmin.rpc('store_article_classification_pass_v6', {
    p_job_id: job.id,
    p_lease_token: job.leaseToken,
    p_pass_kind: job.passKind,
    p_model: model,
    p_provider_response_id: receipt.providerResponseId,
    p_prompt_sha256: receipt.promptSha,
    p_response_sha256: receipt.responseSha,
    p_result: result
  });
  if (error) throw error;
  return data;
}

async function failJob(job: NonNullable<Awaited<ReturnType<typeof claimOneJob>>>, error: unknown) {
  const message = errorMessage(error);
  const retryable = !(error instanceof StructuralOutputError)
    && !message.includes('is not configured')
    && !message.includes('must be configured and distinct')
    && !message.includes('classification_v6_input_stale')
    && !message.includes('classification_v6_membership_evidence_invalid')
    && !message.includes('classification_v6_profile_anchor_not_verified')
    && !message.includes('classification_v6_primary_membership_invalid')
    && !message.includes('classification_v6_unknown_category');
  const { data, error: persistenceError } = await supabaseAdmin.rpc('fail_article_classification_job_v6', {
    p_job_id: job.id,
    p_lease_token: job.leaseToken,
    p_error_message: message,
    p_retryable: retryable
  });
  if (persistenceError) throw persistenceError;
  return data;
}

export async function getVerifiedArticleClassificationStatus() {
  const { data: gate, error: gateError } = await supabaseAdmin.from('article_classification_quality_gate_v6').select('*').maybeSingle();
  if (gateError) throw gateError;
  return { gate };
}

export async function runVerifiedArticleClassificationWorkerStep() {
  const enqueue = await enqueueJobs();
  if (enqueue.blocked) return { stage: 'blocked', reason: 'verified_duplicate_clearance_required', external_calls: 0 };
  const job = await claimOneJob();
  if (!job) return { stage: 'idle', enqueued: enqueue.enqueued, external_calls: 0 };
  let externalCalls = 0;
  try {
    const input = await getInput(job);
    const models = classificationModels();
    const model = job.passKind === 'classifier' ? models.classifier : models.critic;
    externalCalls = 1;
    const receipt = await callResponsesJson({
      model,
      instructions: instructions(job.passKind),
      userText: userText({ articleId: job.articleId, verifiedText: input.verifiedText, catalog: input.catalog })
    });
    const result = parseResult(receipt.value, input.catalogIds);
    const stored = await storePass(job, model, receipt, result);
    return { stage: 'classification_pass', article_id: job.articleId, pass_kind: job.passKind, result: stored, external_calls: externalCalls };
  } catch (error) {
    const result = await failJob(job, error);
    return { stage: 'classification_pass_failed', article_id: job.articleId, pass_kind: job.passKind, error: errorMessage(error), result, external_calls: externalCalls };
  }
}

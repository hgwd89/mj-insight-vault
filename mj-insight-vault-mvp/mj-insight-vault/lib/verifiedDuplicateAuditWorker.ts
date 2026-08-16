import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAIKey, TEXT_MODEL } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;
type ReviewPassKind = 'reviewer' | 'critic';
type Disposition = 'distinct' | 'duplicate' | 'unresolved';

type ClaimedReviewJob = {
  id: string;
  run_id: string;
  article_id_a: string;
  article_id_b: string;
  status: string;
  active_pass_kind: ReviewPassKind;
  failure_count: number;
  lease_token: string;
};

class StructuralOutputError extends Error {}
class ProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const CALL_TIMEOUT_MS = 150_000;
const MIN_DECISION_CONFIDENCE = 0.85;

const DUPLICATE_RESPONSE_FORMAT = {
  type: 'json_schema',
  name: 'mj_verified_duplicate_review',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['disposition', 'confidence', 'reason'],
    properties: {
      disposition: { type: 'string', enum: ['distinct', 'duplicate', 'unresolved'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' }
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
  return text(error) || 'verified duplicate review worker failed';
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

function reviewModels() {
  const reviewer = process.env.OPENAI_DUPLICATE_REVIEWER_MODEL?.trim() || TEXT_MODEL;
  const fallbackCritic = reviewer === 'gpt-4o' ? 'gpt-4.1' : 'gpt-4o';
  const critic = process.env.OPENAI_DUPLICATE_CRITIC_MODEL?.trim() || fallbackCritic;
  if (!reviewer || !critic || reviewer === critic) {
    throw new StructuralOutputError('Duplicate reviewer and critic models must be configured and distinct.');
  }
  return { reviewer, critic };
}

function reviewInstructions(passKind: ReviewPassKind) {
  const role = passKind === 'reviewer'
    ? 'You are the first independent duplicate auditor for a verified newspaper corpus.'
    : 'You are an independent second duplicate auditor. Do not assume or imitate any prior auditor.';
  return [
    role,
    'You receive exactly two OCR transcriptions that have already passed crop OCR and independent visual verification.',
    'Decide whether they are the same editorial article duplicated/republished in the corpus, or two genuinely distinct editorial articles.',
    'Shared topic, entities, event, boilerplate, or nearby wording is not enough for duplicate.',
    'Duplicate requires substantially the same editorial content: the same factual sequence and materially overlapping wording or a clear duplicate extraction of the same article.',
    'Distinct means the texts are separate editorial works even if they discuss the same subject or quote the same source.',
    'If the evidence is not strong enough either way, choose unresolved. Never force a binary answer.',
    'Do not infer anything from UUID values. They are opaque identifiers only.',
    'Return only the requested JSON.'
  ].join('\n');
}

function reviewUserText(input: {
  articleAId: string;
  articleAText: string;
  articleBId: string;
  articleBText: string;
}) {
  return JSON.stringify({
    task: 'verified_ocr_duplicate_or_distinct',
    article_a: { article_id: input.articleAId, verified_crop_ocr_text: input.articleAText },
    article_b: { article_id: input.articleBId, verified_crop_ocr_text: input.articleBText }
  });
}

async function callResponsesJson(input: {
  model: string;
  instructions: string;
  userText: string;
}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new StructuralOutputError('OPENAI_API_KEY is not configured.');

  const promptSha = sha256([input.model, input.instructions, input.userText].join('\n---\n'));
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
        max_output_tokens: 1600,
        instructions: input.instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: input.userText }] }],
        text: { format: DUPLICATE_RESPONSE_FORMAT }
      })
    });
    const raw = await res.text();
    if (!res.ok) {
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      throw new ProviderError(`OpenAI Responses API failed: ${res.status} ${res.statusText} ${raw.slice(0, 2000)}`, retryable);
    }
    let responseJson: JsonRecord;
    try {
      responseJson = JSON.parse(raw) as JsonRecord;
    } catch {
      throw new ProviderError('OpenAI duplicate review response JSON is malformed.', true);
    }
    const providerResponseId = text(responseJson.id);
    const outputText = extractResponseText(responseJson);
    if (!providerResponseId || !outputText) throw new ProviderError('OpenAI duplicate review receipt or output_text is missing.', true);
    let value: unknown;
    try {
      value = JSON.parse(outputText) as unknown;
    } catch {
      throw new StructuralOutputError('OpenAI duplicate review structured output is invalid JSON.');
    }
    return {
      value,
      providerResponseId,
      promptSha,
      responseSha: sha256(raw)
    };
  } catch (error) {
    if (error instanceof ProviderError || error instanceof StructuralOutputError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError('OpenAI duplicate review request timed out.', true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseDecision(value: unknown) {
  const root = isRecord(value) ? value : {};
  const rawDisposition = text(root.disposition) as Disposition;
  if (!['distinct', 'duplicate', 'unresolved'].includes(rawDisposition)) {
    throw new StructuralOutputError('duplicate disposition is invalid');
  }
  const confidence = Number(root.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new StructuralOutputError('duplicate confidence is invalid');
  }
  const reason = text(root.reason);
  if (!reason) throw new StructuralOutputError('duplicate reason is missing');
  const disposition: Disposition = confidence < MIN_DECISION_CONFIDENCE && rawDisposition !== 'unresolved'
    ? 'unresolved'
    : rawDisposition;
  return {
    disposition,
    confidence,
    reason: disposition === rawDisposition
      ? reason.slice(0, 1500)
      : `low_confidence_downgrade(${confidence.toFixed(3)}): ${reason}`.slice(0, 1500)
  };
}

async function readLatestRun() {
  const { data, error } = await supabaseAdmin
    .from('source_grounded_duplicate_audit_runs_v5')
    .select('*')
    .eq('detection_version', 'verified_ocr_duplicate_audit_v6')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function ensureCurrentRun() {
  const { data: embeddingGate, error: gateError } = await supabaseAdmin
    .from('article_embedding_quality_gate_v5')
    .select('*')
    .maybeSingle();
  if (gateError) throw gateError;
  if (!embeddingGate || embeddingGate.embedding_gate !== 'passed') {
    return { blocked: true as const, reason: embeddingGate?.gate_reason || 'verified_embeddings_required', run: null };
  }

  const { data: runId, error: createError } = await supabaseAdmin.rpc('create_source_grounded_duplicate_audit_run_v6');
  if (createError) throw createError;
  const id = text(runId);
  if (!id) throw new StructuralOutputError('Duplicate audit run creation returned no id.');
  const { data: run, error: runError } = await supabaseAdmin
    .from('source_grounded_duplicate_audit_runs_v5')
    .select('*')
    .eq('id', id)
    .single();
  if (runError) throw runError;
  return { blocked: false as const, reason: '', run };
}

async function populateIfNeeded(run: JsonRecord) {
  const status = text(run.status);
  if (status !== 'queued' && status !== 'running') return null;
  const { data, error } = await supabaseAdmin.rpc('populate_source_grounded_duplicate_candidates_v6', { p_run_id: text(run.id) });
  if (error) throw error;
  return { stage: 'candidate_generation', candidate_count: Number(data || 0), run_id: text(run.id) };
}

async function claimOneReviewJob() {
  const { data, error } = await supabaseAdmin.rpc('claim_source_grounded_duplicate_review_job_v7', { p_lease_seconds: 240 });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job: ClaimedReviewJob = {
    id: text(row.id),
    run_id: text(row.run_id),
    article_id_a: text(row.article_id_a),
    article_id_b: text(row.article_id_b),
    status: text(row.status),
    active_pass_kind: text(row.active_pass_kind) as ReviewPassKind,
    failure_count: Number(row.failure_count || 0),
    lease_token: text(row.lease_token)
  };
  if (!job.id || !job.run_id || !job.article_id_a || !job.article_id_b || !job.lease_token || !['reviewer', 'critic'].includes(job.active_pass_kind)) {
    throw new StructuralOutputError('Invalid claimed duplicate review job.');
  }
  return job;
}

async function getReviewInput(job: ClaimedReviewJob) {
  const { data, error } = await supabaseAdmin.rpc('get_source_grounded_duplicate_review_input_v7', {
    p_job_id: job.id,
    p_lease_token: job.lease_token
  });
  if (error) throw error;
  if (!isRecord(data) || !isRecord(data.article_a) || !isRecord(data.article_b)) {
    throw new StructuralOutputError('duplicate review input is malformed');
  }
  const articleAId = text(data.article_a.article_id);
  const articleBId = text(data.article_b.article_id);
  const articleAText = text(data.article_a.verified_text);
  const articleBText = text(data.article_b.verified_text);
  if (!articleAId || !articleBId || !articleAText || !articleBText) {
    throw new StructuralOutputError('verified duplicate review text is missing');
  }
  return { articleAId, articleAText, articleBId, articleBText };
}

async function storeDecision(job: ClaimedReviewJob, model: string, receipt: Awaited<ReturnType<typeof callResponsesJson>>, decision: ReturnType<typeof parseDecision>) {
  const { data, error } = await supabaseAdmin.rpc('store_source_grounded_duplicate_review_v7', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_pass_kind: job.active_pass_kind,
    p_model: model,
    p_provider_response_id: receipt.providerResponseId,
    p_prompt_sha256: receipt.promptSha,
    p_response_sha256: receipt.responseSha,
    p_disposition: decision.disposition,
    p_confidence: decision.confidence,
    p_reason: decision.reason
  });
  if (error) throw error;
  return data;
}

async function failJob(job: ClaimedReviewJob, error: unknown) {
  const message = errorMessage(error);
  const retryable = error instanceof ProviderError ? error.retryable : false;
  const { data, error: persistenceError } = await supabaseAdmin.rpc('fail_source_grounded_duplicate_review_job_v7', {
    p_job_id: job.id,
    p_lease_token: job.lease_token,
    p_error: message,
    p_retryable: retryable
  });
  if (persistenceError) throw persistenceError;
  return data;
}

async function reviewJobCounts(runId: string) {
  const { data, error } = await supabaseAdmin
    .from('source_grounded_duplicate_review_jobs_v7')
    .select('status')
    .eq('run_id', runId);
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const row of data || []) {
    const status = text(row.status) || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

export async function getVerifiedDuplicateAuditStatus() {
  const [{ data: gate, error: gateError }, run] = await Promise.all([
    supabaseAdmin.from('source_grounded_duplicate_gate_v6').select('*').maybeSingle(),
    readLatestRun()
  ]);
  if (gateError) throw gateError;
  return {
    gate,
    run,
    review_jobs: run?.id ? await reviewJobCounts(String(run.id)) : {}
  };
}

export async function runVerifiedDuplicateAuditWorkerStep() {
  const current = await ensureCurrentRun();
  if (current.blocked || !current.run) {
    return { stage: 'blocked', reason: current.reason, external_calls: 0 };
  }

  const population = await populateIfNeeded(current.run as JsonRecord);
  if (population) return { ...population, external_calls: 0 };

  const run = current.run as JsonRecord;
  if (text(run.status) === 'completed') {
    return {
      stage: 'already_completed',
      run_id: text(run.id),
      candidate_count: Number(run.candidate_count || 0),
      distinct_count: Number(run.distinct_count || 0),
      duplicate_count: Number(run.duplicate_count || 0),
      unresolved_count: Number(run.unresolved_count || 0),
      external_calls: 0
    };
  }
  if (text(run.status) !== 'reviewing') {
    throw new StructuralOutputError(`Duplicate audit run is in unexpected status: ${text(run.status)}`);
  }

  const job = await claimOneReviewJob();
  if (!job) {
    const counts = await reviewJobCounts(text(run.id));
    if ((counts.needs_review || 0) > 0 || (counts.failed || 0) > 0 || (counts.queued || 0) > 0 || (counts.running || 0) > 0) {
      return { stage: 'review_jobs_incomplete', run_id: text(run.id), review_jobs: counts, external_calls: 0 };
    }
    const { data, error } = await supabaseAdmin.rpc('finalize_source_grounded_duplicate_audit_v7', { p_run_id: text(run.id) });
    if (error) throw error;
    return { stage: 'finalized', run_id: text(run.id), result: data, external_calls: 0 };
  }

  let externalCalls = 0;
  try {
    const input = await getReviewInput(job);
    const models = reviewModels();
    const model = job.active_pass_kind === 'reviewer' ? models.reviewer : models.critic;
    externalCalls = 1;
    const receipt = await callResponsesJson({
      model,
      instructions: reviewInstructions(job.active_pass_kind),
      userText: reviewUserText(input)
    });
    const decision = parseDecision(receipt.value);
    const stored = await storeDecision(job, model, receipt, decision);
    return {
      stage: 'review_pass',
      run_id: job.run_id,
      review_job_id: job.id,
      pass_kind: job.active_pass_kind,
      disposition: decision.disposition,
      confidence: decision.confidence,
      result: stored,
      external_calls: externalCalls
    };
  } catch (error) {
    const result = await failJob(job, error);
    return {
      stage: 'review_pass_failed',
      run_id: job.run_id,
      review_job_id: job.id,
      pass_kind: job.active_pass_kind,
      error: errorMessage(error),
      result,
      external_calls: externalCalls
    };
  }
}

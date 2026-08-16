import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAIKey } from '@/lib/openai';

type JsonRecord = Record<string, unknown>;
class StructuralOutputError extends Error {}
class ProviderError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

const MODEL = 'text-embedding-3-small';
const CALL_TIMEOUT_MS = 120_000;
const EXPECTED_DIMENSIONS = 1536;

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
  return text(error) || 'verified article embedding worker failed';
}

async function callEmbedding(input: string) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new StructuralOutputError('OPENAI_API_KEY is not configured.');
  if (!input.trim()) throw new StructuralOutputError('verified embedding input is empty');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({ model: MODEL, input, encoding_format: 'float' })
    });
    const raw = await response.text();
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      throw new ProviderError(`OpenAI Embeddings API failed: ${response.status} ${response.statusText} ${raw.slice(0, 1800)}`, retryable);
    }
    let json: JsonRecord;
    try { json = JSON.parse(raw) as JsonRecord; }
    catch { throw new ProviderError('OpenAI embedding response JSON is malformed.', true); }

    const data = Array.isArray(json.data) ? json.data : [];
    const row = data.length === 1 && isRecord(data[0]) ? data[0] : null;
    const vector = row && Array.isArray(row.embedding) ? row.embedding.map(Number) : [];
    if (vector.length !== EXPECTED_DIMENSIONS || vector.some((v) => !Number.isFinite(v))) {
      throw new StructuralOutputError(`embedding vector must contain exactly ${EXPECTED_DIMENSIONS} finite values`);
    }
    const requestId = text(response.headers.get('x-request-id'));
    if (!requestId) throw new ProviderError('OpenAI embedding x-request-id is missing.', true);
    return {
      vector,
      providerRequestId: requestId,
      responseSha256: sha256(raw)
    };
  } catch (error) {
    if (error instanceof ProviderError || error instanceof StructuralOutputError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError('OpenAI embedding request timed out.', true);
    }
    if (error instanceof TypeError) {
      throw new ProviderError(`OpenAI embedding network failure: ${error.message}`, true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function enqueue() {
  const { data, error } = await supabaseAdmin.rpc('enqueue_article_embedding_jobs_v5');
  if (error) {
    const message = errorMessage(error);
    if (message.includes('embedding_v6_ocr_verification_not_passed') || message.includes('embedding_v6_ocr_receipt_missing')) {
      return { blocked: true as const, count: 0, reason: message };
    }
    throw error;
  }
  return { blocked: false as const, count: Number(data || 0), reason: '' };
}

async function claim() {
  const { data, error } = await supabaseAdmin.rpc('claim_article_embedding_job_v5', { p_lease_seconds: 240 });
  if (error) throw error;
  const row = Array.isArray(data) && isRecord(data[0]) ? data[0] : null;
  if (!row) return null;
  const job = {
    id: text(row.id),
    articleId: text(row.article_id),
    inputText: text(row.embedding_input_text),
    inputSha256: text(row.embedding_input_sha256),
    leaseToken: text(row.lease_token)
  };
  if (!job.id || !job.articleId || !job.inputText || !job.inputSha256 || !job.leaseToken) {
    throw new StructuralOutputError('claimed verified embedding job is malformed');
  }
  if (sha256(job.inputText) !== job.inputSha256) {
    throw new StructuralOutputError('claimed verified embedding input fingerprint mismatch');
  }
  return job;
}

async function complete(job: NonNullable<Awaited<ReturnType<typeof claim>>>, result: Awaited<ReturnType<typeof callEmbedding>>) {
  const { data, error } = await supabaseAdmin.rpc('complete_article_embedding_job_v5', {
    p_job_id: job.id,
    p_lease_token: job.leaseToken,
    p_embedding_vector_text: JSON.stringify(result.vector),
    p_embedding_model: MODEL,
    p_provider_request_id: result.providerRequestId,
    p_response_sha256: result.responseSha256
  });
  if (error) throw error;
  return data;
}

async function fail(job: NonNullable<Awaited<ReturnType<typeof claim>>>, errorValue: unknown) {
  const message = errorMessage(errorValue);
  const retryable = errorValue instanceof ProviderError ? errorValue.retryable : false;
  const errorClass = errorValue instanceof StructuralOutputError ? 'structural' : errorValue instanceof ProviderError ? 'provider' : 'runtime';
  const { data, error } = await supabaseAdmin.rpc('fail_article_embedding_job_v5', {
    p_job_id: job.id,
    p_lease_token: job.leaseToken,
    p_error_message: message,
    p_retryable: retryable,
    p_error_class: errorClass
  });
  if (error) throw error;
  return data;
}

export async function getVerifiedArticleEmbeddingStatus() {
  const [{ data: gate, error: gateError }, { data: jobs, error: jobsError }] = await Promise.all([
    supabaseAdmin.from('article_embedding_quality_gate_v5').select('*').maybeSingle(),
    supabaseAdmin.from('article_embedding_jobs_v4').select('status').eq('embedding_version', 'article_semantic_verified_ocr_v5')
  ]);
  if (gateError) throw gateError;
  if (jobsError) throw jobsError;
  const counts: Record<string, number> = {};
  for (const row of jobs || []) {
    const status = text(row.status) || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return { gate, jobs: counts };
}

export async function runVerifiedArticleEmbeddingWorkerStep() {
  const enqueued = await enqueue();
  if (enqueued.blocked) {
    return { stage: 'blocked', reason: 'verified_ocr_corpus_required', detail: enqueued.reason, external_calls: 0 };
  }
  const job = await claim();
  if (!job) return { stage: 'idle', enqueued: enqueued.count, external_calls: 0 };

  let externalCalls = 0;
  try {
    externalCalls = 1;
    const result = await callEmbedding(job.inputText);
    const stored = await complete(job, result);
    return { stage: 'embedding_completed', article_id: job.articleId, job_id: job.id, result: stored, external_calls: externalCalls };
  } catch (error) {
    const stored = await fail(job, error);
    return { stage: 'embedding_failed', article_id: job.articleId, job_id: job.id, error: errorMessage(error), result: stored, external_calls: externalCalls };
  }
}

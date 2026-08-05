import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI } from '@/lib/openai';
import { fetchAllWideArticles, type WideArticle } from '@/lib/wideArticleRetrieval';

type JsonRecord = Record<string, unknown>;

export const FULL_CORPUS_PROMPT_VERSION = 'full_corpus_batch_v1';
export const MAX_SCAN_TRANSIENT_ATTEMPTS = 4;
export const MAX_SCAN_VALIDATION_ATTEMPTS = 2;

const DEFAULT_SCAN_TIMEOUT_MS = 180_000;
const MIN_SCAN_TIMEOUT_MS = 30_000;
const MAX_SCAN_TIMEOUT_MS = 240_000;
const STALE_BATCH_MS = 10 * 60 * 1000;

type ScanRun = {
  id: string;
  scope_type: string;
  scope_query: string | null;
  status: string;
  model: string;
  batch_size: number;
  active_article_count: number;
  ocr_ready_article_count: number;
  total_batches: number;
  completed_batches: number;
  failed_batches: number;
  needs_review_batches?: number;
  analyzed_article_count: number;
  coverage_json: JsonRecord;
  error_message: string | null;
  corpus_fingerprint?: string | null;
  started_at?: string | null;
};

type ScanBatch = {
  id: string;
  run_id: string;
  batch_index: number;
  article_ids: string[];
  article_count: number;
  status: string;
  model: string;
  attempt_count?: number;
  next_retry_at?: string | null;
  last_error_class?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
};

type ClassifiedError = {
  message: string;
  retryable: boolean;
  errorClass: string;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function num(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function configuredScanTimeoutMs() {
  const parsed = Number(process.env.OPENAI_SCAN_TIMEOUT_MS || DEFAULT_SCAN_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_SCAN_TIMEOUT_MS;
  return Math.max(MIN_SCAN_TIMEOUT_MS, Math.min(MAX_SCAN_TIMEOUT_MS, Math.round(parsed)));
}

function withAbortTimeout<T>(factory: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error(`full corpus batch timed out after ${ms}ms`));
    }, ms);

    factory(controller.signal)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function errorRecord(error: unknown) {
  return isRecord(error) ? error : {};
}

function classifyError(error: unknown): ClassifiedError {
  const record = errorRecord(error);
  const message = error instanceof Error && error.message
    ? error.message
    : text(record.message || record.error || 'batch failed');
  const lower = message.toLowerCase();
  const status = num(record.status || record.statusCode);
  const code = text(record.code).toLowerCase();

  if (lower.includes('openai_api_key is not configured')) {
    return { message, retryable: false, errorClass: 'configuration' };
  }
  if (lower.includes('article payload mismatch') || lower.includes('no articles loaded')) {
    return { message, retryable: false, errorClass: 'data_integrity' };
  }
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return { message, retryable: true, errorClass: status === 429 ? 'rate_limit' : 'provider_transient' };
  }
  if (['etimedout', 'econnreset', 'econnrefused', 'enotfound'].includes(code)) {
    return { message, retryable: true, errorClass: 'network' };
  }
  if (
    lower.includes('rate limit')
    || lower.includes('timed out')
    || lower.includes('timeout')
    || lower.includes('temporarily unavailable')
    || lower.includes('fetch failed')
    || lower.includes('network')
    || lower.includes('connection reset')
  ) {
    return { message, retryable: true, errorClass: lower.includes('rate limit') ? 'rate_limit' : 'network' };
  }
  return { message, retryable: false, errorClass: 'provider_terminal' };
}

function retryDelaySeconds(attemptCount: number) {
  return Math.min(300, 20 * Math.pow(2, Math.max(0, attemptCount - 1)));
}

function validationRetryDelaySeconds(attemptCount: number) {
  return Math.min(60, 10 * Math.max(1, attemptCount));
}

async function updateScanRow(
  table: 'full_corpus_scan_runs' | 'full_corpus_scan_batches',
  id: string,
  patch: Record<string, unknown>
) {
  const { error } = await supabaseAdmin.from(table).update(patch).eq('id', id);
  if (error) throw error;
}

async function claimScanBatch(batch: ScanBatch) {
  const { data, error } = await supabaseAdmin.rpc('claim_full_corpus_scan_batch', {
    p_batch_id: batch.id,
    p_expected_status: batch.status,
    p_expected_updated_at: batch.status === 'running' ? batch.updated_at || null : null
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return isRecord(row) ? row as unknown as ScanBatch : null;
}

function safeJson(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : { raw: parsed };
  } catch {
    return { raw_text: value };
  }
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.map((item) => text(item)).filter(Boolean);
}

function words(query: string) {
  return Array.from(new Set(query
    .replace(/[^\p{Letter}\p{Number}ぁ-んァ-ヶ一-龠々ー]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
    .slice(0, 30)));
}

function matchesScope(article: WideArticle, scopeType: string, scopeQuery: string) {
  if (scopeType !== 'category' || !scopeQuery.trim()) return true;
  const terms = words(scopeQuery);
  if (!terms.length) return true;
  const haystack = `${article.headline || ''}\n${article.article_date || ''}\n${article.ocr_text || ''}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function compactArticle(article: WideArticle, index: number) {
  return {
    no: index + 1,
    article_id: article.id,
    headline: article.headline || '無題の記事',
    article_date: article.article_date || '日付不明',
    text: (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, 6000)
  };
}

async function fetchScopedArticles(scopeType: string, scopeQuery: string) {
  const all = await fetchAllWideArticles();
  if (scopeType !== 'category' || !scopeQuery) return all;

  const { data, error } = await supabaseAdmin
    .from('article_category_memberships')
    .select('article_id')
    .eq('category_id', scopeQuery);
  if (error) throw error;
  const ids = new Set((data || []).map((row) => text(row.article_id)).filter(Boolean));
  if (ids.size > 0) return all.filter((article) => ids.has(article.id));

  return all.filter((article) => matchesScope(article, scopeType, scopeQuery));
}

async function loadArticlesByIds(ids: string[]) {
  if (!ids.length) return [] as WideArticle[];
  const { data, error } = await supabaseAdmin
    .from('articles')
    .select('id, batch_id, headline, article_date, ocr_text, status, created_at')
    .in('id', ids);
  if (error) throw error;
  const byId = new Map((data || []).map((article) => [article.id, article as WideArticle]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as WideArticle[];
}

function evidenceIdsFromSummary(summary: JsonRecord, fallbackIds: string[]) {
  const ids = new Set<string>();
  const evidence = Array.isArray(summary.evidence) ? summary.evidence : [];
  for (const item of evidence) {
    if (isRecord(item)) {
      const id = text(item.article_id || item.id);
      if (id) ids.add(id);
    }
  }
  for (const id of fallbackIds.slice(0, 10)) ids.add(id);
  return Array.from(ids);
}

function validateBatchSummary(summary: JsonRecord, articleIds: string[]) {
  const readIds = new Set(asStringArray(summary.read_article_ids));
  const missingReadIds = articleIds.filter((id) => !readIds.has(id));
  const validated = summary.analysis_is_validated === true && summary.fallback_used !== true;
  const hasEvidence = Array.isArray(summary.evidence) && summary.evidence.length > 0;
  const hasNarrativeOrSignal = (Array.isArray(summary.consumer_narratives) && summary.consumer_narratives.length > 0)
    || (Array.isArray(summary.behavior_signals) && summary.behavior_signals.length > 0)
    || (Array.isArray(summary.weak_signals) && summary.weak_signals.length > 0);

  const failures: string[] = [];
  if (!validated) failures.push('analysis_is_validated is not true or fallback was used');
  if (missingReadIds.length) failures.push(`read_article_ids missing ${missingReadIds.length} article(s)`);
  if (!hasEvidence) failures.push('evidence is empty');
  if (!hasNarrativeOrSignal) failures.push('consumer_narratives / behavior_signals / weak_signals are all empty');

  return { passed: failures.length === 0, failures, missing_read_article_ids: missingReadIds };
}

async function analyzeBatch(articles: WideArticle[], model: string, scopeType: string, scopeQuery: string) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured');
  if (!articles.length) throw new Error('no articles loaded for corpus batch');

  const payload = {
    task: 'Read every article text in this batch and extract consumer narratives and insight seeds. Do not summarize only headlines. Do not overclaim. Separate fact, inference, contradiction, and research need.',
    scope: { scope_type: scopeType, scope_query: scopeQuery || '' },
    required_output: {
      scan_type: 'full_corpus_batch',
      analysis_is_validated: true,
      article_count: articles.length,
      read_article_ids: 'all article_id values actually read',
      consumer_narratives: 'array of concrete consumer narratives, with evidence_article_ids',
      behavior_signals: 'array of observable behavior / market signals, with evidence_article_ids',
      constraints: 'array of consumer constraints / frictions / tradeoffs',
      contradictions: 'array of counter-readings or evidence that weakens simple conclusions',
      category_signals: 'array of category-specific signals if any',
      weak_signals: 'array of small but interesting signs, not generic trends',
      research_needs: 'array of questions that require primary research',
      evidence: 'array of evidence items with article_id, headline, article_date, observed_fact, what_can_be_said, what_cannot_be_said'
    },
    articles: articles.map(compactArticle)
  };

  const completion = await withAbortTimeout(
    (signal) => openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a strict consumer-insight analyst. Read all supplied article texts. Output only JSON. Never claim full-corpus coverage beyond this batch. If a batch contains weak evidence, still record observed facts and what cannot be said.' },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    }, { signal }),
    configuredScanTimeoutMs()
  );
  const parsed = safeJson(completion.choices[0]?.message.content || '{}');
  parsed.scan_type = 'full_corpus_batch';
  parsed.prompt_version = FULL_CORPUS_PROMPT_VERSION;
  parsed.model_used = model;
  parsed.article_count = articles.length;
  return parsed;
}

function corpusFingerprint(input: {
  scopeType: string;
  scopeQuery: string;
  model: string;
  batchSize: number;
  articleIds: string[];
}) {
  const canonical = JSON.stringify({
    scope_type: input.scopeType,
    scope_query: input.scopeQuery,
    model: input.model,
    batch_size: input.batchSize,
    prompt_version: FULL_CORPUS_PROMPT_VERSION,
    article_ids: [...input.articleIds].sort()
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function findRunByFingerprint(scopeType: string, scopeQuery: string, fingerprint: string) {
  let query = supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('scope_type', scopeType)
    .eq('corpus_fingerprint', fingerprint)
    .in('status', ['queued', 'running', 'completed']);
  query = scopeQuery ? query.eq('scope_query', scopeQuery) : query.is('scope_query', null);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return isRecord(data) ? data : null;
}

export async function createFullCorpusScanRun(input: { scope_type?: string; scope_query?: string; model?: string; batch_size?: number }) {
  const scopeType = input.scope_type === 'category' ? 'category' : 'all';
  const scopeQuery = text(input.scope_query);
  const model = text(input.model) || process.env.OPENAI_SCAN_MODEL || 'gpt-4o-mini';
  const batchSize = Math.max(5, Math.min(50, Math.round(Number(input.batch_size || 30))));

  const scoped = await fetchScopedArticles(scopeType, scopeQuery);
  const ocrReady = scoped.filter((article) => text(article.ocr_text));
  const batches = chunk(ocrReady, batchSize);
  const fingerprint = corpusFingerprint({
    scopeType,
    scopeQuery,
    model,
    batchSize,
    articleIds: ocrReady.map((article) => article.id)
  });

  const existing = await findRunByFingerprint(scopeType, scopeQuery, fingerprint);
  if (existing) return getFullCorpusScanRun(text(existing.id));

  const inserted = await supabaseAdmin
    .from('full_corpus_scan_runs')
    .insert({
      scope_type: scopeType,
      scope_query: scopeQuery || null,
      status: batches.length ? 'queued' : 'failed',
      model,
      batch_size: batchSize,
      active_article_count: scoped.length,
      ocr_ready_article_count: ocrReady.length,
      total_batches: batches.length,
      corpus_fingerprint: fingerprint,
      coverage_json: {
        active_article_count: scoped.length,
        ocr_ready_article_count: ocrReady.length,
        missing_ocr_count: scoped.length - ocrReady.length,
        batch_size: batchSize,
        total_batches: batches.length,
        prompt_version: FULL_CORPUS_PROMPT_VERSION,
        corpus_fingerprint: fingerprint,
        full_corpus_gate: batches.length && scoped.length === ocrReady.length ? 'pending' : 'failed'
      },
      error_message: batches.length ? null : 'No OCR-ready articles matched this scan scope.'
    })
    .select('*')
    .single();

  if (inserted.error) {
    if (inserted.error.code === '23505') {
      const raced = await findRunByFingerprint(scopeType, scopeQuery, fingerprint);
      if (raced) return getFullCorpusScanRun(text(raced.id));
    }
    throw inserted.error;
  }

  const run = inserted.data;
  const batchRows = batches.map((articles, index) => ({
    run_id: run.id,
    batch_index: index + 1,
    article_ids: articles.map((article) => article.id),
    article_count: articles.length,
    status: 'queued',
    model,
    prompt_version: FULL_CORPUS_PROMPT_VERSION,
    attempt_count: 0,
    next_retry_at: null,
    last_error_class: null
  }));

  if (batchRows.length) {
    const { error: batchError } = await supabaseAdmin.from('full_corpus_scan_batches').insert(batchRows);
    if (batchError) {
      await supabaseAdmin.from('full_corpus_scan_runs').delete().eq('id', run.id);
      throw batchError;
    }
  }

  return getFullCorpusScanRun(run.id);
}

export async function getFullCorpusScanRun(id: string) {
  const { data: run, error } = await supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;

  const { data: batches, error: batchError } = await supabaseAdmin
    .from('full_corpus_scan_batches')
    .select('id, run_id, batch_index, article_ids, article_count, status, model, attempt_count, next_retry_at, last_error_class, error_message, created_at, updated_at, started_at, finished_at')
    .eq('run_id', id)
    .order('batch_index', { ascending: true });
  if (batchError) throw batchError;

  return { run: run as ScanRun, batches: batches || [] };
}

export async function getLatestFullCorpusScanRun(scopeType = 'all', scopeQuery = '') {
  let query = supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('scope_type', scopeType);
  if (scopeQuery) query = query.eq('scope_query', scopeQuery);
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ScanRun | null;
}

function compactSummary(summary: unknown) {
  if (!isRecord(summary)) return summary;
  return {
    article_count: summary.article_count,
    read_article_ids: Array.isArray(summary.read_article_ids) ? summary.read_article_ids.slice(0, 40) : [],
    consumer_narratives: Array.isArray(summary.consumer_narratives) ? summary.consumer_narratives.slice(0, 8) : [],
    behavior_signals: Array.isArray(summary.behavior_signals) ? summary.behavior_signals.slice(0, 8) : [],
    constraints: Array.isArray(summary.constraints) ? summary.constraints.slice(0, 6) : [],
    contradictions: Array.isArray(summary.contradictions) ? summary.contradictions.slice(0, 6) : [],
    category_signals: Array.isArray(summary.category_signals) ? summary.category_signals.slice(0, 6) : [],
    weak_signals: Array.isArray(summary.weak_signals) ? summary.weak_signals.slice(0, 6) : [],
    research_needs: Array.isArray(summary.research_needs) ? summary.research_needs.slice(0, 6) : [],
    evidence: Array.isArray(summary.evidence) ? summary.evidence.slice(0, 10) : []
  };
}

export async function getFullCorpusContext(scopeType = 'all', scopeQuery = '') {
  const run = await getLatestFullCorpusScanRun(scopeType, scopeQuery);
  if (!run) return { run: null, context_text: '', full_corpus_gate: 'failed', reason: 'no_full_corpus_scan_run' };

  const { data: gateData, error: gateError } = await supabaseAdmin
    .from('corpus_scan_gate_view')
    .select('full_corpus_gate, gate_reason, current_article_count, current_article_count_diff')
    .eq('id', run.id)
    .maybeSingle();
  if (gateError) throw gateError;

  const { data: batches, error } = await supabaseAdmin
    .from('full_corpus_scan_batches')
    .select('batch_index, article_count, status, summary_json, evidence_article_ids')
    .eq('run_id', run.id)
    .order('batch_index', { ascending: true });
  if (error) throw error;

  const completed = (batches || []).filter((batch) => batch.status === 'completed');
  const gate = text(gateData?.full_corpus_gate) || 'failed';
  const context = completed.map((batch) => ({
    batch_index: batch.batch_index,
    article_count: batch.article_count,
    summary: compactSummary(batch.summary_json)
  }));

  return {
    run,
    batches: batches || [],
    completed_batches: completed.length,
    full_corpus_gate: gate,
    gate_reason: text(gateData?.gate_reason),
    current_article_count: Number(gateData?.current_article_count || run.active_article_count),
    current_article_count_diff: Number(gateData?.current_article_count_diff || 0),
    context_text: JSON.stringify({
      full_corpus_gate: gate,
      gate_reason: text(gateData?.gate_reason),
      run_id: run.id,
      scope_type: run.scope_type,
      scope_query: run.scope_query,
      active_article_count: run.active_article_count,
      current_article_count: Number(gateData?.current_article_count || run.active_article_count),
      current_article_count_diff: Number(gateData?.current_article_count_diff || 0),
      ocr_ready_article_count: run.ocr_ready_article_count,
      analyzed_article_count: run.analyzed_article_count,
      total_batches: run.total_batches,
      completed_batches: run.completed_batches,
      failed_batches: run.failed_batches,
      needs_review_batches: run.needs_review_batches || 0,
      batch_summaries: context
    })
  };
}

function retryDue(batch: ScanBatch) {
  const value = text(batch.next_retry_at);
  if (!value) return true;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) || parsed <= Date.now();
}

function retryableBatch(batch: ScanBatch) {
  const attempts = num(batch.attempt_count);
  if (batch.status === 'queued') return retryDue(batch);
  if (batch.status === 'failed') return attempts < MAX_SCAN_TRANSIENT_ATTEMPTS && retryDue(batch);
  if (batch.status === 'needs_review') return attempts < MAX_SCAN_VALIDATION_ATTEMPTS && retryDue(batch);
  if (batch.status !== 'running') return false;
  const touchedAt = Date.parse(text(batch.updated_at || batch.started_at || ''));
  return Number.isFinite(touchedAt) && touchedAt < Date.now() - STALE_BATCH_MS;
}

function terminalBatch(batch: ScanBatch) {
  const attempts = num(batch.attempt_count);
  if (batch.status === 'failed') {
    return attempts >= MAX_SCAN_TRANSIENT_ATTEMPTS
      || batch.last_error_class === 'configuration'
      || batch.last_error_class === 'data_integrity'
      || batch.last_error_class === 'provider_terminal';
  }
  if (batch.status === 'needs_review') return attempts >= MAX_SCAN_VALIDATION_ATTEMPTS;
  return false;
}

export async function runFullCorpusScanBatches(id: string, maxBatches = 2) {
  const { data: gateData, error: gateError } = await supabaseAdmin
    .from('corpus_scan_gate_view')
    .select('gate_reason, current_article_count_diff')
    .eq('id', id)
    .maybeSingle();
  if (gateError) throw gateError;
  if (gateData?.gate_reason === 'run_stale_article_count_mismatch') {
    throw new Error(`run is stale; rebuild required. current_article_count_diff=${gateData.current_article_count_diff}`);
  }

  const { data: run, error } = await supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  if (!run) throw new Error('full corpus scan run not found');
  if (run.status === 'completed') return getFullCorpusScanRun(id);

  await updateScanRow('full_corpus_scan_runs', id, {
    status: 'running',
    started_at: run.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error_message: null
  });

  const requestedBatches = Math.max(1, Math.min(10, Math.round(maxBatches)));
  const { data: allBatches, error: batchError } = await supabaseAdmin
    .from('full_corpus_scan_batches')
    .select('*')
    .eq('run_id', id)
    .order('batch_index', { ascending: true });
  if (batchError) throw batchError;

  const eligible = ((allBatches || []) as ScanBatch[])
    .filter(retryableBatch)
    .slice(0, requestedBatches);

  for (const candidate of eligible) {
    const batch = await claimScanBatch(candidate);
    if (!batch) continue;
    const attemptCount = Math.max(1, num(batch.attempt_count));

    try {
      const articles = await loadArticlesByIds(batch.article_ids);
      if (articles.length !== batch.article_ids.length) {
        throw new Error(`article payload mismatch: expected ${batch.article_ids.length}, loaded ${articles.length}`);
      }
      const summary = await analyzeBatch(articles, batch.model || run.model, run.scope_type, run.scope_query || '');
      const validation = validateBatchSummary(summary, batch.article_ids);
      const evidenceIds = evidenceIdsFromSummary(summary, batch.article_ids);

      if (validation.passed) {
        await updateScanRow('full_corpus_scan_batches', batch.id, {
          status: 'completed',
          summary_json: { ...summary, validation },
          evidence_article_ids: evidenceIds,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          next_retry_at: null,
          last_error_class: null,
          error_message: null
        });
      } else if (attemptCount < MAX_SCAN_VALIDATION_ATTEMPTS) {
        const delaySeconds = validationRetryDelaySeconds(attemptCount);
        await updateScanRow('full_corpus_scan_batches', batch.id, {
          status: 'queued',
          summary_json: { ...summary, validation },
          evidence_article_ids: evidenceIds,
          finished_at: null,
          updated_at: new Date().toISOString(),
          next_retry_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
          last_error_class: 'validation',
          error_message: validation.failures.join('; ')
        });
      } else {
        await updateScanRow('full_corpus_scan_batches', batch.id, {
          status: 'needs_review',
          summary_json: { ...summary, validation },
          evidence_article_ids: evidenceIds,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          next_retry_at: null,
          last_error_class: 'validation',
          error_message: validation.failures.join('; ')
        });
      }
    } catch (error) {
      const classified = classifyError(error);
      if (classified.retryable && attemptCount < MAX_SCAN_TRANSIENT_ATTEMPTS) {
        const delaySeconds = retryDelaySeconds(attemptCount);
        await updateScanRow('full_corpus_scan_batches', batch.id, {
          status: 'queued',
          error_message: classified.message,
          last_error_class: classified.errorClass,
          next_retry_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
          finished_at: null,
          updated_at: new Date().toISOString()
        });
      } else {
        await updateScanRow('full_corpus_scan_batches', batch.id, {
          status: 'failed',
          error_message: classified.message,
          last_error_class: classified.errorClass,
          next_retry_at: null,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
    }
  }

  const latest = await getFullCorpusScanRun(id);
  const batches = latest.batches as ScanBatch[];
  const terminalCount = batches.filter(terminalBatch).length;
  const retryableCount = batches.filter(retryableBatch).length;
  const done = latest.run.completed_batches === latest.run.total_batches
    && latest.run.total_batches > 0
    && latest.run.failed_batches === 0
    && Number(latest.run.needs_review_batches || 0) === 0;
  const nextStatus = done ? 'completed' : terminalCount > 0 ? 'needs_review' : 'running';
  const fullCorpusGate = done && latest.run.analyzed_article_count === latest.run.ocr_ready_article_count ? 'passed' : 'failed';

  await updateScanRow('full_corpus_scan_runs', id, {
    status: nextStatus,
    finished_at: done ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
    error_message: terminalCount > 0 ? `${terminalCount} terminal batch(es) require intervention` : null,
    coverage_json: {
      ...(latest.run.coverage_json || {}),
      completed_batches: latest.run.completed_batches,
      failed_batches: latest.run.failed_batches,
      needs_review_batches: Number(latest.run.needs_review_batches || 0),
      analyzed_article_count: latest.run.analyzed_article_count,
      retryable_batches: retryableCount,
      terminal_batches: terminalCount,
      full_corpus_gate: fullCorpusGate
    }
  });

  return getFullCorpusScanRun(id);
}

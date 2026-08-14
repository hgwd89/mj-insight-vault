import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { FULL_CORPUS_PROMPT_VERSION } from '@/lib/fullCorpusScan';

type JsonRecord = Record<string, unknown>;
type ScopeType = 'all' | 'category';

type RunRow = JsonRecord & {
  id?: string;
  status?: string;
  scope_type?: string;
  scope_query?: string | null;
  active_article_count?: number;
  ocr_ready_article_count?: number;
  analyzed_article_count?: number;
  total_batches?: number;
  completed_batches?: number;
  failed_batches?: number;
  needs_review_batches?: number;
  corpus_fingerprint?: string | null;
};

type BatchRow = JsonRecord & {
  id?: string;
  batch_index?: number;
  article_ids?: string[];
  article_count?: number;
  status?: string;
  prompt_version?: string;
  summary_json?: unknown;
};

export type FullCorpusIntegrityContext = {
  run: RunRow | null;
  batches: BatchRow[];
  context_text: string;
  full_corpus_gate: string;
  gate_reason: string;
  full_corpus_integrity_gate: 'passed' | 'failed';
  integrity_failures: string[];
  represented_batches: number;
  represented_article_count: number;
  omitted_batches: number;
  prompt_version: string;
  current_article_count: number;
  current_article_count_diff: number;
};

const MAX_CONTEXT_CHARS = 70_000;
const HEADER_RESERVE_CHARS = 12_000;
const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function num(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function normalize(value: unknown, max = 180) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, max);
  if (!isRecord(value)) return text(value).replace(/\s+/g, ' ').slice(0, max);
  const preferred = [
    value.narrative,
    value.consumer_narrative,
    value.signal,
    value.behavior_signal,
    value.theme,
    value.constraint,
    value.contradiction,
    value.weak_signal,
    value.question,
    value.research_question,
    value.observed_fact,
    value.what_can_be_said,
    value.summary,
    value.claim
  ].map(text).find(Boolean);
  return (preferred || JSON.stringify(value)).replace(/\s+/g, ' ').slice(0, max);
}

function firstText(summary: JsonRecord, keys: string[], max = 180) {
  for (const key of keys) {
    const value = summary[key];
    if (Array.isArray(value)) {
      const first = value.map((item) => normalize(item, max)).find(Boolean);
      if (first) return first;
    }
    const direct = normalize(value, max);
    if (direct) return direct;
  }
  return '';
}

function compactEvidence(summary: JsonRecord, max = 180) {
  const evidence = Array.isArray(summary.evidence) ? summary.evidence : [];
  for (const item of evidence) {
    if (!isRecord(item)) continue;
    const articleId = text(item.article_id || item.id);
    const fact = normalize(item.observed_fact || item.what_can_be_said || item.evidence_excerpt_or_fact, max);
    if (articleId && fact) return { article_id: articleId, observed_fact: fact };
  }
  return null;
}

function exactSameIds(expected: string[], actual: string[]) {
  if (expected.length !== actual.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((id) => expectedSet.has(id)) && expectedSet.size === new Set(actual).size;
}

function validateBatch(batch: BatchRow) {
  const failures: string[] = [];
  const summary = isRecord(batch.summary_json) ? batch.summary_json : {};
  const articleIds = stringArray(batch.article_ids);
  const readIds = stringArray(summary.read_article_ids);
  const evidence = Array.isArray(summary.evidence) ? summary.evidence.filter(isRecord) : [];
  const noSignal = summary.no_signal_detected === true;
  const hasSignal = ['consumer_narratives', 'behavior_signals', 'weak_signals', 'constraints', 'contradictions']
    .some((key) => Array.isArray(summary[key]) && (summary[key] as unknown[]).length > 0);

  if (text(batch.status) !== 'completed') failures.push('status_not_completed');
  if (text(batch.prompt_version) !== FULL_CORPUS_PROMPT_VERSION) failures.push('prompt_version_mismatch');
  if (summary.analysis_is_validated !== true) failures.push('analysis_not_validated');
  if (summary.fallback_used === true) failures.push('fallback_used');
  if (!articleIds.length || num(batch.article_count) !== articleIds.length) failures.push('article_count_mismatch');
  if (!exactSameIds(articleIds, readIds)) failures.push('read_article_ids_mismatch');
  if (!evidence.length && !noSignal) failures.push('evidence_missing_without_no_signal');
  if (!hasSignal && !noSignal) failures.push('signal_missing_without_no_signal');

  return { failures, summary, articleIds };
}

async function latestRun(scopeType: ScopeType, scopeQuery: string) {
  let query = supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('scope_type', scopeType)
    .order('created_at', { ascending: false })
    .limit(1);
  query = scopeType === 'category'
    ? query.eq('scope_query', scopeQuery)
    : query.is('scope_query', null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return isRecord(data) ? data as RunRow : null;
}

async function loadArticles(ids: string[]) {
  const rows: JsonRecord[] = [];
  for (let index = 0; index < ids.length; index += 500) {
    const part = ids.slice(index, index + 500);
    const { data, error } = await supabaseAdmin
      .from('formal_corpus_articles_v1')
      .select('id, article_type, status, ocr_text')
      .in('id', part);
    if (error) throw error;
    rows.push(...((data || []).filter(isRecord)));
  }
  return rows;
}

function buildDigest(batch: BatchRow, perBatchBudget: number) {
  const summary = isRecord(batch.summary_json) ? batch.summary_json : {};
  const digest: JsonRecord = {
    batch_index: num(batch.batch_index),
    article_count: num(batch.article_count),
    primary_observation: firstText(summary, ['consumer_narratives', 'behavior_signals', 'constraints', 'weak_signals'], 170),
    counter_reading: firstText(summary, ['contradictions'], 140),
    research_need: firstText(summary, ['research_needs'], 130),
    no_signal_detected: summary.no_signal_detected === true
  };
  const evidence = compactEvidence(summary, 150);
  if (evidence) digest.evidence = evidence;

  while (JSON.stringify(digest).length > perBatchBudget) {
    if (digest.research_need) delete digest.research_need;
    else if (digest.counter_reading) delete digest.counter_reading;
    else if (digest.evidence) delete digest.evidence;
    else if (typeof digest.primary_observation === 'string' && digest.primary_observation.length > 60) {
      digest.primary_observation = digest.primary_observation.slice(0, Math.max(60, digest.primary_observation.length - 30));
    } else break;
  }
  return digest;
}

export async function getIntegrityCheckedFullCorpusContext(
  scopeType: ScopeType = 'all',
  scopeQuery = ''
): Promise<FullCorpusIntegrityContext> {
  const run = await latestRun(scopeType, scopeQuery);
  if (!run) {
    return {
      run: null,
      batches: [],
      context_text: '',
      full_corpus_gate: 'failed',
      gate_reason: 'no_full_corpus_scan_run',
      full_corpus_integrity_gate: 'failed',
      integrity_failures: ['no_full_corpus_scan_run'],
      represented_batches: 0,
      represented_article_count: 0,
      omitted_batches: 0,
      prompt_version: FULL_CORPUS_PROMPT_VERSION,
      current_article_count: 0,
      current_article_count_diff: 0
    };
  }

  const [{ data: gateData, error: gateError }, { data: batchData, error: batchError }] = await Promise.all([
    supabaseAdmin
      .from('corpus_scan_gate_view')
      .select('full_corpus_gate, gate_reason, current_article_count, current_article_count_diff')
      .eq('id', text(run.id))
      .maybeSingle(),
    supabaseAdmin
      .from('full_corpus_scan_batches')
      .select('id, batch_index, article_ids, article_count, status, prompt_version, summary_json')
      .eq('run_id', text(run.id))
      .order('batch_index', { ascending: true })
  ]);
  if (gateError) throw gateError;
  if (batchError) throw batchError;

  const batches = (batchData || []).filter(isRecord) as BatchRow[];
  const integrityFailures: string[] = [];
  const allArticleIds: string[] = [];

  if (text(gateData?.full_corpus_gate) !== 'passed') integrityFailures.push(`count_gate:${text(gateData?.gate_reason) || 'failed'}`);
  if (text(run.status) !== 'completed') integrityFailures.push('run_not_completed');
  if (batches.length !== num(run.total_batches)) integrityFailures.push('batch_row_count_mismatch');

  for (const batch of batches) {
    const checked = validateBatch(batch);
    allArticleIds.push(...checked.articleIds);
    for (const failure of checked.failures) {
      integrityFailures.push(`batch_${num(batch.batch_index)}:${failure}`);
    }
  }

  const uniqueIds = new Set(allArticleIds);
  if (uniqueIds.size !== allArticleIds.length) integrityFailures.push('duplicate_article_ids_across_batches');
  if (uniqueIds.size !== num(run.active_article_count)) integrityFailures.push('run_article_count_mismatch');
  if (num(run.analyzed_article_count) !== uniqueIds.size) integrityFailures.push('analyzed_article_count_mismatch');

  const articleRows = await loadArticles(Array.from(uniqueIds));
  const byId = new Map(articleRows.map((row) => [text(row.id), row]));
  for (const id of uniqueIds) {
    const row = byId.get(id);
    if (!row) {
      integrityFailures.push(`article_missing:${id}`);
      continue;
    }
    if (text(row.article_type) !== 'article') integrityFailures.push(`non_article_record:${id}`);
    if (HIDDEN.has(text(row.status))) integrityFailures.push(`hidden_article_record:${id}`);
    if (!text(row.ocr_text)) integrityFailures.push(`empty_article_text:${id}`);
  }

  const perBatchBudget = Math.max(260, Math.floor((MAX_CONTEXT_CHARS - HEADER_RESERVE_CHARS) / Math.max(1, batches.length)));
  const digests = batches.map((batch) => buildDigest(batch, perBatchBudget));
  const representedArticleCount = batches.reduce((sum, batch) => sum + num(batch.article_count), 0);
  const integrityGate = integrityFailures.length ? 'failed' : 'passed';
  const payload = {
    full_corpus_gate: text(gateData?.full_corpus_gate) || 'failed',
    full_corpus_integrity_gate: integrityGate,
    integrity_failures: integrityFailures.slice(0, 100),
    prompt_version: FULL_CORPUS_PROMPT_VERSION,
    run_id: text(run.id),
    corpus_fingerprint: text(run.corpus_fingerprint),
    scope_type: scopeType,
    scope_query: scopeQuery,
    active_article_count: num(run.active_article_count),
    analyzed_article_count: num(run.analyzed_article_count),
    total_batches: num(run.total_batches),
    represented_batches: digests.length,
    represented_article_count: representedArticleCount,
    omitted_batches: 0,
    final_context_strategy: 'all_batches_uniform_compact_digest_v1',
    per_batch_char_budget: perBatchBudget,
    batch_digests: digests
  };
  const contextText = JSON.stringify(payload);
  if (contextText.length > MAX_CONTEXT_CHARS) {
    integrityFailures.push(`final_context_budget_exceeded:${contextText.length}`);
  }

  return {
    run,
    batches,
    context_text: contextText.length <= MAX_CONTEXT_CHARS ? contextText : '',
    full_corpus_gate: text(gateData?.full_corpus_gate) || 'failed',
    gate_reason: text(gateData?.gate_reason) || 'unknown',
    full_corpus_integrity_gate: integrityFailures.length ? 'failed' : 'passed',
    integrity_failures: integrityFailures,
    represented_batches: digests.length,
    represented_article_count: representedArticleCount,
    omitted_batches: 0,
    prompt_version: FULL_CORPUS_PROMPT_VERSION,
    current_article_count: num(gateData?.current_article_count),
    current_article_count_diff: num(gateData?.current_article_count_diff)
  };
}

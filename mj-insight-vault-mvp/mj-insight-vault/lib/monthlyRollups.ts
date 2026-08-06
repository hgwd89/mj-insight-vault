import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';

export type RollupArticle = {
  id: string;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
  status?: string | null;
  created_at?: string | null;
};

export type MonthlyRollupRow = {
  id: string;
  month_key: string;
  article_count: number;
  article_ids: string[];
  source_latest_article_at: string | null;
  rollup_model: string;
  status: 'ready' | 'stale' | 'running' | 'failed' | 'provisional' | string;
  summary_text: string;
  summary_json: Record<string, unknown> | null;
  representative_article_ids: string[] | null;
  evidence_article_ids: string[] | null;
  error_message: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
};

type RollupJson = Record<string, unknown>;

type RollupNode = {
  node_id: string;
  level: number;
  chunk_index: number;
  source_article_ids: string[];
  source_article_count: number;
  summary_text: string;
  summary_json: RollupJson;
  representative_article_ids: string[];
  evidence_article_ids: string[];
};

export const UNDATED_MONTH_KEY = 'undated';

const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const SELECT = 'id, headline, article_date, ocr_text, status, created_at';
const PAGE_SIZE = 1000;
const RUNNING_LOCK_MS = 10 * 60 * 1000;
const MONTH_BATCH_LIMIT = Number(process.env.MONTHLY_ROLLUP_BATCH_LIMIT || 3);

const ROLLUP_MODEL = process.env.OPENAI_ROLLUP_MODEL || TEXT_MODEL;
const ROLLUP_ARTICLE_TEXT_LIMIT = boundedNumber(process.env.MONTHLY_ROLLUP_ARTICLE_TEXT_LIMIT, 1200, 500, 2400);
const ROLLUP_REQUEST_CHAR_BUDGET = boundedNumber(process.env.MONTHLY_ROLLUP_REQUEST_CHAR_BUDGET, 70_000, 30_000, 90_000);
const ROLLUP_CHUNK_MAX_ARTICLES = boundedNumber(process.env.MONTHLY_ROLLUP_CHUNK_MAX_ARTICLES, 24, 5, 40);
const ROLLUP_REDUCE_MAX_ITEMS = boundedNumber(process.env.MONTHLY_ROLLUP_REDUCE_MAX_ITEMS, 10, 2, 20);
const ROLLUP_CONCURRENCY = boundedNumber(process.env.MONTHLY_ROLLUP_CONCURRENCY, 3, 1, 5);
const ROLLUP_MAX_ATTEMPTS = boundedNumber(process.env.MONTHLY_ROLLUP_MAX_ATTEMPTS, 3, 1, 5);
const ROLLUP_TIMEOUT_MS = boundedNumber(process.env.MONTHLY_ROLLUP_TIMEOUT_MS, 120_000, 30_000, 240_000);
const ROLLUP_MAX_REDUCTION_LEVELS = 8;
const ROLLUP_PROMPT_VERSION = 'hierarchical_monthly_rollup_v1';

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function active(article: RollupArticle) {
  return !article.status || !HIDDEN.has(article.status);
}

function validateMonthKey(monthKey: string) {
  if (monthKey === UNDATED_MONTH_KEY) return;
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) throw new Error('month_key must be YYYY-MM or undated');
}

export function monthKeyFromDate(value: unknown) {
  const date = String(value || '').trim();
  const iso = date.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}`;
  const slash = date.match(/^(\d{4})\/(\d{1,2})/);
  if (slash) return `${slash[1]}-${slash[2].padStart(2, '0')}`;
  const jp = date.match(/^(\d{4})年\s*(\d{1,2})月/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, '0')}`;
  return UNDATED_MONTH_KEY;
}

function articleBelongsToMonth(article: RollupArticle, monthKey: string) {
  return monthKeyFromDate(article.article_date) === monthKey;
}

function articleSortKey(article: RollupArticle) {
  return String(article.article_date || article.created_at || '');
}

function articleLink(article: RollupArticle) {
  return `[${article.headline || 'No title'}｜${article.article_date || 'No date'}](/articles/${article.id})`;
}

function monthLabel(monthKey: string) {
  return monthKey === UNDATED_MONTH_KEY ? 'No date' : monthKey;
}

function isFreshRunningRollup(rollup: MonthlyRollupRow | null) {
  if (!rollup || rollup.status !== 'running') return false;
  const updatedAt = Date.parse(String(rollup.updated_at || ''));
  if (!updatedAt || Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt < RUNNING_LOCK_MS;
}

function boundedBatchLimit(limit?: number) {
  const n = Number(limit || MONTH_BATCH_LIMIT || 3);
  return Math.max(1, Math.min(3, Number.isFinite(n) ? n : 3));
}

function rollupText(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is RollupJson {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function rollupList(value: unknown, max = 12) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function uniqueStrings(values: unknown[], max = Number.POSITIVE_INFINITY) {
  return Array.from(new Set(values.map(rollupText).filter(Boolean))).slice(0, max);
}

function allowedArticleIds(value: unknown, allowed: Set<string>, max = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value)) return [] as string[];
  return uniqueStrings(value.filter((id) => allowed.has(rollupText(id))), max);
}

function sanitizeEvidenceMatrix(value: unknown, allowed: Set<string>, max = 24) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const articleId = rollupText(item.article_id || item.id);
      if (!articleId || !allowed.has(articleId)) return null;
      return {
        ...item,
        article_id: articleId
      };
    })
    .filter(Boolean)
    .slice(0, max);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error)) return rollupText(error.message || error.error || 'monthly rollup synthesis failed');
  return 'monthly rollup synthesis failed';
}

function errorStatus(error: unknown) {
  if (!isRecord(error)) return 0;
  const value = Number(error.status || error.statusCode || 0);
  return Number.isFinite(value) ? value : 0;
}

function retryableRollupError(error: unknown) {
  const status = errorStatus(error);
  const message = errorMessage(error).toLowerCase();
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return message.includes('rate limit')
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('temporarily unavailable')
    || message.includes('fetch failed')
    || message.includes('connection reset')
    || message.includes('network');
}

function contextLengthError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes('maximum context length')
    || message.includes('context_length_exceeded')
    || message.includes('please reduce the length');
}

function compactArticleText(value: unknown) {
  const normalized = rollupText(value).replace(/\s+/g, ' ');
  if (normalized.length <= ROLLUP_ARTICLE_TEXT_LIMIT) return normalized;
  const headLength = Math.floor(ROLLUP_ARTICLE_TEXT_LIMIT * 0.72);
  const tailLength = ROLLUP_ARTICLE_TEXT_LIMIT - headLength;
  return `${normalized.slice(0, headLength)} … ${normalized.slice(-tailLength)}`;
}

function compactArticle(article: RollupArticle) {
  return {
    article_id: article.id,
    headline: article.headline || '',
    article_date: article.article_date || article.created_at || '',
    article_text: compactArticleText(article.ocr_text)
  };
}

function serializedChars(value: unknown) {
  return JSON.stringify(value).length;
}

function chunkArticlesByBudget(articles: RollupArticle[]) {
  const chunks: RollupArticle[][] = [];
  let current: RollupArticle[] = [];
  let currentChars = 4_000;

  for (const article of articles) {
    const articleChars = serializedChars(compactArticle(article)) + 16;
    const exceedsItems = current.length >= ROLLUP_CHUNK_MAX_ARTICLES;
    const exceedsChars = current.length > 0 && currentChars + articleChars > ROLLUP_REQUEST_CHAR_BUDGET;
    if (exceedsItems || exceedsChars) {
      chunks.push(current);
      current = [];
      currentChars = 4_000;
    }
    current.push(article);
    currentChars += articleChars;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

function compactNode(node: RollupNode) {
  const summary = node.summary_json;
  return {
    node_id: node.node_id,
    source_article_count: node.source_article_count,
    source_article_ids: node.source_article_ids,
    summary_text: node.summary_text.slice(0, 5000),
    major_themes: rollupList(summary.major_themes, 10),
    consumer_narrative: rollupText(summary.consumer_narrative).slice(0, 3000),
    weak_signals: rollupList(summary.weak_signals, 8),
    contradictions: rollupList(summary.contradictions || summary.refutation_notes, 8),
    research_needs: rollupList(summary.research_needs, 8),
    evidence_matrix: rollupList(summary.evidence_matrix, 12),
    representative_article_ids: node.representative_article_ids.slice(0, 30),
    evidence_article_ids: node.evidence_article_ids.slice(0, 50)
  };
}

function chunkNodesByBudget(nodes: RollupNode[]) {
  const groups: RollupNode[][] = [];
  let current: RollupNode[] = [];
  let currentChars = 4_000;

  for (const node of nodes) {
    const nodeChars = serializedChars(compactNode(node)) + 16;
    const exceedsItems = current.length >= ROLLUP_REDUCE_MAX_ITEMS;
    const exceedsChars = current.length > 0 && currentChars + nodeChars > ROLLUP_REQUEST_CHAR_BUDGET;
    if (exceedsItems || exceedsChars) {
      groups.push(current);
      current = [];
      currentChars = 4_000;
    }
    current.push(node);
    currentChars += nodeChars;
  }

  if (current.length) groups.push(current);
  if (groups.length === nodes.length && nodes.length > 1) {
    const paired: RollupNode[][] = [];
    for (let index = 0; index < nodes.length; index += 2) paired.push(nodes.slice(index, index + 2));
    return paired;
  }
  return groups;
}

function sourceFingerprint(monthKey: string, articles: RollupArticle[]) {
  const canonical = JSON.stringify({
    month_key: monthKey,
    prompt_version: ROLLUP_PROMPT_VERSION,
    model: ROLLUP_MODEL,
    article_text_limit: ROLLUP_ARTICLE_TEXT_LIMIT,
    article_ids: articles.map((article) => article.id)
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function fetchAllRollupArticles(select = SELECT) {
  const rows: RollupArticle[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('articles')
      .select(select)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data || []) as unknown as RollupArticle[]));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

export async function listMonthlyRollups() {
  const { data, error } = await supabaseAdmin
    .from('monthly_rollups')
    .select('*')
    .order('month_key', { ascending: false });
  if (error) throw error;
  return (data || []) as MonthlyRollupRow[];
}

export async function listStaleRollupMonths() {
  const { data, error } = await supabaseAdmin
    .from('monthly_rollups')
    .select('month_key,status')
    .eq('status', 'stale')
    .order('month_key', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => String(row.month_key)).filter(Boolean);
}

export async function getArticlesForMonth(monthKey: string) {
  validateMonthKey(monthKey);
  const data = await fetchAllRollupArticles();
  return data
    .filter(active)
    .filter((article) => articleBelongsToMonth(article, monthKey))
    .sort((a, b) => articleSortKey(a).localeCompare(articleSortKey(b)));
}

export async function listArticleMonths() {
  const data = await fetchAllRollupArticles('id, article_date, status, created_at');
  const months = new Set<string>();
  for (const row of data) {
    if (row.status && HIDDEN.has(row.status)) continue;
    months.add(monthKeyFromDate(row.article_date));
  }
  return Array.from(months).sort((a, b) => {
    if (a === UNDATED_MONTH_KEY) return 1;
    if (b === UNDATED_MONTH_KEY) return -1;
    return b.localeCompare(a);
  });
}

export async function listArticleMonthCounts() {
  const data = await fetchAllRollupArticles('id, article_date, status, created_at');
  const counts: Record<string, number> = {};
  for (const row of data) {
    if (row.status && HIDDEN.has(row.status)) continue;
    const monthKey = monthKeyFromDate(row.article_date);
    counts[monthKey] = (counts[monthKey] || 0) + 1;
  }
  return counts;
}

export async function listNeededRollupMonths() {
  const [months, rollups] = await Promise.all([listArticleMonths(), listMonthlyRollups()]);
  const byMonth = new Map(rollups.map((rollup) => [rollup.month_key, rollup]));
  return months.filter((month) => {
    const rollup = byMonth.get(month);
    return !rollup
      || ['stale', 'failed', 'provisional'].includes(rollup.status)
      || rollup.rollup_model === 'extractive_fallback';
  });
}

export async function markMonthlyRollupsStaleForArticleDates(articleDates: unknown[]) {
  const months = Array.from(new Set(articleDates.map(monthKeyFromDate)));
  if (!months.length) return { months: [], updated: 0 };

  const { data, error } = await supabaseAdmin
    .from('monthly_rollups')
    .update({
      status: 'stale',
      error_message: null,
      updated_at: new Date().toISOString()
    })
    .in('month_key', months)
    .neq('status', 'running')
    .select('month_key');

  if (error) throw error;
  return { months, updated: data?.length || 0 };
}

export async function generateStaleMonthlyRollups(limit?: number) {
  const months = (await listStaleRollupMonths()).slice(0, boundedBatchLimit(limit));
  const results: MonthlyRollupRow[] = [];
  for (const month of months) results.push(await generateMonthlyRollup(month));
  return results;
}

export async function generateNeededMonthlyRollups(limit?: number) {
  const months = (await listNeededRollupMonths()).slice(0, boundedBatchLimit(limit));
  const results: MonthlyRollupRow[] = [];
  for (const month of months) results.push(await generateMonthlyRollup(month));
  return results;
}

function buildFallbackRollup(
  monthKey: string,
  articles: RollupArticle[],
  reason: string,
  progress: RollupJson = {}
) {
  const representative = articles.slice(0, 40).map((article) => article.id);
  const evidence = articles.slice(0, 80).map((article) => article.id);
  const topLines = articles.slice(0, 30).map((article, index) => (
    `${index + 1}. ${articleLink(article)}: ${compactArticleText(article.ocr_text).slice(0, 120)}`
  ));
  const label = monthLabel(monthKey);
  const summary = [
    `## ${label} monthly rollup (extractive fallback)`,
    `Source articles: ${articles.length}. ${reason}`,
    '',
    '## Evidence candidates',
    topLines.join('\n') || 'No evidence candidates',
    '',
    '## Limitation',
    'This is an extractive fallback. It is not valid as a formal monthly rollup.'
  ].join('\n');

  return {
    summary,
    summaryJson: {
      ...progress,
      month_key: monthKey,
      month_label: label,
      article_count: articles.length,
      summary_text: summary,
      major_themes: ['extractive fallback; themes not synthesized'],
      consumer_narrative: 'Article IDs and representative evidence only.',
      weak_signals: [],
      evidence_matrix: topLines,
      refutation_notes: [reason],
      research_needs: ['Regenerate this month with hierarchical LLM synthesis.'],
      representative_article_ids: representative,
      evidence_article_ids: evidence,
      generation_warning: 'extractive_fallback_rollup',
      fallback_used: true,
      rollup_analysis_is_validated: false
    },
    representative,
    evidence
  };
}

async function upsertMonthlyRollup(
  monthKey: string,
  articleCount: number,
  articleIds: string[],
  latestDate: string | null,
  model: string,
  summaryText: string,
  summaryJson: Record<string, unknown>,
  representativeIds: string[],
  evidenceIds: string[],
  status: string,
  errorMessage: string | null
) {
  const { data, error } = await supabaseAdmin
    .from('monthly_rollups')
    .upsert({
      month_key: monthKey,
      article_count: articleCount,
      article_ids: articleIds,
      source_latest_article_at: latestDate,
      rollup_model: model,
      status,
      summary_text: summaryText,
      summary_json: summaryJson,
      representative_article_ids: representativeIds,
      evidence_article_ids: evidenceIds,
      error_message: errorMessage,
      generated_at: status === 'ready' || status === 'provisional' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'month_key' })
    .select('*')
    .single();
  if (error) throw error;
  return data as MonthlyRollupRow;
}

async function callRollupJson(
  system: string,
  payload: RollupJson,
  maxTokens: number
) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured');

  const userContent = JSON.stringify(payload);
  if (userContent.length > ROLLUP_REQUEST_CHAR_BUDGET) {
    throw new Error(`monthly rollup preflight budget exceeded: ${userContent.length} chars > ${ROLLUP_REQUEST_CHAR_BUDGET}`);
  }

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= ROLLUP_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROLLUP_TIMEOUT_MS);
    try {
      const completion = await openai.chat.completions.create({
        model: ROLLUP_MODEL,
        response_format: { type: 'json_object' },
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent }
        ]
      }, { signal: controller.signal });

      const parsedText = completion.choices[0]?.message.content || '{}';
      const parsed = JSON.parse(parsedText);
      if (!isRecord(parsed)) throw new Error('monthly rollup LLM returned non-object JSON');
      return parsed;
    } catch (error) {
      lastError = error;
      if (contextLengthError(error)) throw error;
      if (!retryableRollupError(error) || attempt >= ROLLUP_MAX_ATTEMPTS) throw error;
      await sleep(Math.min(20_000, 1000 * (2 ** (attempt - 1))));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('monthly rollup LLM synthesis failed');
}

function buildNode(
  parsed: RollupJson,
  sourceArticleIds: string[],
  level: number,
  chunkIndex: number,
  nodeId: string
): RollupNode {
  const allowed = new Set(sourceArticleIds);
  const summaryText = rollupText(parsed.summary_text || parsed.summary || parsed.consumer_narrative);
  if (!summaryText) throw new Error('monthly rollup LLM returned no summary_text');

  const evidenceMatrix = sanitizeEvidenceMatrix(parsed.evidence_matrix, allowed);
  const matrixIds = evidenceMatrix
    .filter(isRecord)
    .map((item) => rollupText(item.article_id))
    .filter(Boolean);

  const representative = allowedArticleIds(parsed.representative_article_ids, allowed, 40);
  const evidence = allowedArticleIds(parsed.evidence_article_ids, allowed, 80);
  const representativeIds = representative.length
    ? representative
    : uniqueStrings([...matrixIds, ...sourceArticleIds], 40);
  const evidenceIds = evidence.length
    ? evidence
    : uniqueStrings([...matrixIds, ...sourceArticleIds], 80);

  return {
    node_id: nodeId,
    level,
    chunk_index: chunkIndex,
    source_article_ids: sourceArticleIds,
    source_article_count: sourceArticleIds.length,
    summary_text: summaryText,
    summary_json: {
      summary_text: summaryText,
      major_themes: rollupList(parsed.major_themes),
      consumer_narrative: rollupText(parsed.consumer_narrative) || summaryText,
      weak_signals: rollupList(parsed.weak_signals),
      contradictions: rollupList(parsed.contradictions || parsed.refutation_notes),
      research_needs: rollupList(parsed.research_needs),
      evidence_matrix: evidenceMatrix,
      representative_article_ids: representativeIds,
      evidence_article_ids: evidenceIds
    },
    representative_article_ids: representativeIds,
    evidence_article_ids: evidenceIds
  };
}

async function synthesizeArticleChunk(
  monthKey: string,
  articles: RollupArticle[],
  chunkIndex: number,
  totalChunks: number
) {
  const sourceArticleIds = articles.map((article) => article.id);
  const payload = {
    task: 'Read every supplied article text and produce a grounded chunk summary for a later monthly synthesis. Do not infer causality from article coverage alone.',
    month_key: monthKey,
    chunk_index: chunkIndex + 1,
    total_chunks: totalChunks,
    article_count: articles.length,
    required_output: {
      summary_text: 'Concise synthesis grounded in all supplied article texts.',
      major_themes: 'Observable themes with concrete wording.',
      consumer_narrative: 'Visible consumer tension or change and what remains uncertain.',
      weak_signals: 'Small or emerging signals.',
      contradictions: 'Counter-readings or limiting evidence.',
      research_needs: 'Questions requiring primary research.',
      evidence_matrix: 'Evidence items with article_id and observed_fact.',
      representative_article_ids: 'IDs from supplied articles only.',
      evidence_article_ids: 'IDs from supplied articles only.'
    },
    articles: articles.map(compactArticle)
  };

  const parsed = await callRollupJson(
    'You are a strict consumer-insight analyst. Read every supplied article text. Output only JSON. Separate observed facts, interpretation, contradictions, and research needs. Never invent article IDs.',
    payload,
    2400
  );

  return buildNode(parsed, sourceArticleIds, 0, chunkIndex, `chunk-${chunkIndex + 1}`);
}

async function synthesizeNodeGroup(
  monthKey: string,
  nodes: RollupNode[],
  level: number,
  groupIndex: number,
  final: boolean
) {
  const sourceArticleIds = uniqueStrings(nodes.flatMap((node) => node.source_article_ids));
  const payload = {
    task: final
      ? 'Synthesize the supplied grounded chunk summaries into one formal monthly consumer-insight rollup.'
      : 'Reduce the supplied grounded summaries into a smaller grounded synthesis for the next hierarchy level.',
    month_key: monthKey,
    hierarchy_level: level,
    group_index: groupIndex + 1,
    source_article_count: sourceArticleIds.length,
    final_monthly_synthesis: final,
    required_output: {
      summary_text: 'A concise synthesis grounded only in the supplied summaries.',
      major_themes: 'Observable themes, not generic labels.',
      consumer_narrative: 'Consumer change or tension and uncertainty.',
      weak_signals: 'Small or emerging signals.',
      contradictions: 'Counter-readings or limiting evidence.',
      research_needs: 'Questions requiring primary research.',
      evidence_matrix: 'Evidence items using article IDs present in supplied summaries.',
      representative_article_ids: 'IDs present in supplied summaries only.',
      evidence_article_ids: 'IDs present in supplied summaries only.'
    },
    source_summaries: nodes.map(compactNode)
  };

  const parsed = await callRollupJson(
    'You are a strict synthesis analyst. Combine only the supplied grounded summaries. Output only JSON. Preserve contradictions and uncertainty. Never invent article IDs or claim causal proof.',
    payload,
    final ? 4000 : 2600
  );

  return buildNode(parsed, sourceArticleIds, level, groupIndex, `level-${level}-group-${groupIndex + 1}`);
}

function recoverPartialNodes(existing: MonthlyRollupRow | null, fingerprint: string, totalChunks: number) {
  const summary = isRecord(existing?.summary_json) ? existing?.summary_json : {};
  if (rollupText(summary.source_fingerprint) !== fingerprint) return new Map<number, RollupNode>();
  if (Number(summary.total_chunks || 0) !== totalChunks) return new Map<number, RollupNode>();

  const recovered = new Map<number, RollupNode>();
  const partial = Array.isArray(summary.partial_chunks) ? summary.partial_chunks : [];
  for (const item of partial) {
    if (!isRecord(item)) continue;
    const index = Number(item.chunk_index);
    const sourceIds = Array.isArray(item.source_article_ids) ? uniqueStrings(item.source_article_ids) : [];
    if (!Number.isInteger(index) || index < 0 || index >= totalChunks || !sourceIds.length) continue;
    const summaryJson = isRecord(item.summary_json) ? item.summary_json : {};
    const summaryText = rollupText(item.summary_text);
    if (!summaryText) continue;
    recovered.set(index, {
      node_id: rollupText(item.node_id) || `chunk-${index + 1}`,
      level: 0,
      chunk_index: index,
      source_article_ids: sourceIds,
      source_article_count: sourceIds.length,
      summary_text: summaryText,
      summary_json: summaryJson,
      representative_article_ids: Array.isArray(item.representative_article_ids)
        ? uniqueStrings(item.representative_article_ids, 40)
        : [],
      evidence_article_ids: Array.isArray(item.evidence_article_ids)
        ? uniqueStrings(item.evidence_article_ids, 80)
        : []
    });
  }
  return recovered;
}

async function persistRollupProgress(
  monthKey: string,
  fingerprint: string,
  totalChunks: number,
  nodes: Map<number, RollupNode>,
  hierarchyLevel = 0
) {
  const partialChunks = Array.from(nodes.entries())
    .sort(([a], [b]) => a - b)
    .map(([, node]) => node);
  const { error } = await supabaseAdmin
    .from('monthly_rollups')
    .update({
      status: 'running',
      rollup_model: ROLLUP_MODEL,
      summary_text: `Generating hierarchical monthly rollup: ${partialChunks.length}/${totalChunks} source chunks completed.`,
      summary_json: {
        generation_method: 'hierarchical_llm',
        prompt_version: ROLLUP_PROMPT_VERSION,
        source_fingerprint: fingerprint,
        total_chunks: totalChunks,
        completed_chunks: partialChunks.length,
        hierarchy_level: hierarchyLevel,
        request_char_budget: ROLLUP_REQUEST_CHAR_BUDGET,
        partial_chunks: partialChunks
      },
      error_message: null,
      updated_at: new Date().toISOString()
    })
    .eq('month_key', monthKey);
  if (error) throw error;
}

async function synthesizeMonthlyRollup(
  monthKey: string,
  articles: RollupArticle[],
  existing: MonthlyRollupRow | null
) {
  const chunks = chunkArticlesByBudget(articles);
  if (!chunks.length) throw new Error('monthly rollup has no source chunks');

  const fingerprint = sourceFingerprint(monthKey, articles);
  const recovered = recoverPartialNodes(existing, fingerprint, chunks.length);
  await persistRollupProgress(monthKey, fingerprint, chunks.length, recovered);

  for (let start = 0; start < chunks.length; start += ROLLUP_CONCURRENCY) {
    const waveIndexes = Array.from(
      { length: Math.min(ROLLUP_CONCURRENCY, chunks.length - start) },
      (_, offset) => start + offset
    ).filter((index) => !recovered.has(index));

    if (!waveIndexes.length) continue;
    const wave = await Promise.all(waveIndexes.map(async (index) => (
      [index, await synthesizeArticleChunk(monthKey, chunks[index], index, chunks.length)] as const
    )));
    for (const [index, node] of wave) recovered.set(index, node);
    await persistRollupProgress(monthKey, fingerprint, chunks.length, recovered);
  }

  let current = Array.from(recovered.entries())
    .sort(([a], [b]) => a - b)
    .map(([, node]) => node);
  if (current.length !== chunks.length) {
    throw new Error(`monthly rollup chunk coverage mismatch: ${current.length}/${chunks.length}`);
  }

  let level = 1;
  while (level <= ROLLUP_MAX_REDUCTION_LEVELS) {
    const groups = chunkNodesByBudget(current);
    const finalLevel = groups.length === 1;
    const next: RollupNode[] = [];

    for (let start = 0; start < groups.length; start += ROLLUP_CONCURRENCY) {
      const waveGroups = groups.slice(start, start + ROLLUP_CONCURRENCY);
      const wave = await Promise.all(waveGroups.map((group, offset) => (
        synthesizeNodeGroup(monthKey, group, level, start + offset, finalLevel)
      )));
      next.push(...wave);
    }

    if (next.length === 1) {
      const finalNode = next[0];
      const allowed = new Set(articles.map((article) => article.id));
      const representativeIds = uniqueStrings(
        finalNode.representative_article_ids.filter((id) => allowed.has(id)),
        40
      );
      const evidenceIds = uniqueStrings(
        finalNode.evidence_article_ids.filter((id) => allowed.has(id)),
        80
      );
      const representative = representativeIds.length
        ? representativeIds
        : uniqueStrings(current.flatMap((node) => node.representative_article_ids), 40);
      const evidence = evidenceIds.length
        ? evidenceIds
        : uniqueStrings(current.flatMap((node) => node.evidence_article_ids), 80);

      return {
        model: ROLLUP_MODEL,
        summary: finalNode.summary_text,
        summaryJson: {
          month_key: monthKey,
          month_label: monthLabel(monthKey),
          article_count: articles.length,
          summary_text: finalNode.summary_text,
          major_themes: rollupList(finalNode.summary_json.major_themes),
          consumer_narrative: rollupText(finalNode.summary_json.consumer_narrative) || finalNode.summary_text,
          weak_signals: rollupList(finalNode.summary_json.weak_signals),
          contradictions: rollupList(finalNode.summary_json.contradictions),
          research_needs: rollupList(finalNode.summary_json.research_needs),
          evidence_matrix: rollupList(finalNode.summary_json.evidence_matrix, 24),
          representative_article_ids: representative,
          evidence_article_ids: evidence,
          source_article_ids: articles.map((article) => article.id),
          source_fingerprint: fingerprint,
          source_chunk_count: chunks.length,
          hierarchy_levels: level,
          request_char_budget: ROLLUP_REQUEST_CHAR_BUDGET,
          article_text_limit: ROLLUP_ARTICLE_TEXT_LIMIT,
          rollup_analysis_is_validated: true,
          generation_method: 'hierarchical_llm',
          prompt_version: ROLLUP_PROMPT_VERSION,
          fallback_used: false
        },
        representative,
        evidence
      };
    }

    current = next;
    level += 1;
  }

  throw new Error('monthly rollup hierarchy did not converge');
}

export async function generateMonthlyRollup(monthKey: string) {
  validateMonthKey(monthKey);
  const { data: existingData, error: existingError } = await supabaseAdmin
    .from('monthly_rollups')
    .select('*')
    .eq('month_key', monthKey)
    .maybeSingle();
  if (existingError) throw existingError;
  const existing = existingData as MonthlyRollupRow | null;
  if (isFreshRunningRollup(existing)) return existing as MonthlyRollupRow;

  const articles = await getArticlesForMonth(monthKey);
  const articleIds = articles.map((article) => article.id);
  const latestDate = articles
    .map((article) => article.article_date || article.created_at || '')
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  if (!articles.length) {
    return upsertMonthlyRollup(
      monthKey,
      0,
      [],
      null,
      'empty_rollup_v1',
      `${monthLabel(monthKey)} has no source articles.`,
      {
        month_key: monthKey,
        article_count: 0,
        rollup_analysis_is_validated: true,
        generation_method: 'empty',
        fallback_used: false
      },
      [],
      [],
      'ready',
      null
    );
  }

  const plannedChunks = chunkArticlesByBudget(articles);
  const fingerprint = sourceFingerprint(monthKey, articles);
  const recoveredBeforeStart = recoverPartialNodes(existing, fingerprint, plannedChunks.length);
  const partialChunksBeforeStart = Array.from(recoveredBeforeStart.entries())
    .sort(([a], [b]) => a - b)
    .map(([, node]) => node);

  await upsertMonthlyRollup(
    monthKey,
    articles.length,
    articleIds,
    latestDate,
    ROLLUP_MODEL,
    `Preparing hierarchical monthly rollup: ${partialChunksBeforeStart.length}/${plannedChunks.length} source chunks recovered.`,
    {
      generation_method: 'hierarchical_llm',
      prompt_version: ROLLUP_PROMPT_VERSION,
      source_fingerprint: fingerprint,
      total_chunks: plannedChunks.length,
      completed_chunks: partialChunksBeforeStart.length,
      partial_chunks: partialChunksBeforeStart
    },
    [],
    [],
    'running',
    null
  );

  let synthesisError = 'OPENAI_API_KEY is not configured';
  if (getOpenAI()) {
    try {
      const current = await supabaseAdmin
        .from('monthly_rollups')
        .select('*')
        .eq('month_key', monthKey)
        .maybeSingle();
      if (current.error) throw current.error;
      const synthesized = await synthesizeMonthlyRollup(
        monthKey,
        articles,
        current.data as MonthlyRollupRow | null
      );
      return upsertMonthlyRollup(
        monthKey,
        articles.length,
        articleIds,
        latestDate,
        synthesized.model,
        synthesized.summary,
        synthesized.summaryJson,
        synthesized.representative,
        synthesized.evidence,
        'ready',
        null
      );
    } catch (error) {
      synthesisError = errorMessage(error);
    }
  }

  const progressRow = await supabaseAdmin
    .from('monthly_rollups')
    .select('summary_json')
    .eq('month_key', monthKey)
    .maybeSingle();
  const progress = isRecord(progressRow.data?.summary_json) ? progressRow.data.summary_json : {};
  const fallback = buildFallbackRollup(
    monthKey,
    articles,
    `Hierarchical LLM synthesis unavailable: ${synthesisError}`,
    progress
  );

  return upsertMonthlyRollup(
    monthKey,
    articles.length,
    articleIds,
    latestDate,
    'extractive_fallback',
    fallback.summary,
    fallback.summaryJson,
    fallback.representative,
    fallback.evidence,
    'provisional',
    `extractive fallback is not valid as a formal monthly rollup; ${synthesisError}`
  );
}

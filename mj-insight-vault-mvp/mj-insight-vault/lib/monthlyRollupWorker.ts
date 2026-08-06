import { createHash } from 'node:crypto';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type MonthlyRollupArticle = {
  id: string;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
  status?: string | null;
  created_at?: string | null;
};

type JsonRecord = Record<string, unknown>;

type EvidenceItem = {
  article_id: string;
  observed_fact: string;
  claim?: string;
  limitation?: string;
  evidence_strength?: string;
};

type RollupNode = {
  node_id: string;
  level: number;
  source_article_ids: string[];
  source_article_count: number;
  summary_text: string;
  major_themes: unknown[];
  consumer_narrative: string;
  weak_signals: unknown[];
  contradictions: unknown[];
  research_needs: unknown[];
  evidence_matrix: EvidenceItem[];
  representative_article_ids: string[];
  evidence_article_ids: string[];
};

type WorkerState = {
  generation_method: 'hierarchical_llm_worker';
  worker_version: typeof WORKER_VERSION;
  prompt_version: typeof PROMPT_VERSION;
  source_fingerprint: string;
  phase: 'chunks' | 'reduce';
  total_chunks: number;
  completed_chunks: number;
  chunks: RollupNode[];
  current_level: number;
  current_nodes: RollupNode[];
  next_nodes: RollupNode[];
  next_group_index: number;
  request_char_budget: number;
  article_text_limit: number;
  chunk_max_articles: number;
  reduce_max_items: number;
  model: string;
};

type RollupRow = {
  id: string;
  month_key: string;
  article_count: number;
  article_ids: string[];
  status: string;
  summary_text: string;
  summary_json: JsonRecord | null;
  rollup_model: string;
  error_message: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  updated_at: string;
};

const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const PAGE_SIZE = 1000;
const WORKER_VERSION = 'monthly_rollup_worker_v1' as const;
const PROMPT_VERSION = 'hierarchical_monthly_rollup_v2' as const;
const MODEL = process.env.OPENAI_ROLLUP_MODEL || TEXT_MODEL;
const ARTICLE_TEXT_LIMIT = boundedNumber(process.env.MONTHLY_ROLLUP_ARTICLE_TEXT_LIMIT, 1200, 500, 2400);
const REQUEST_CHAR_BUDGET = boundedNumber(process.env.MONTHLY_ROLLUP_REQUEST_CHAR_BUDGET, 70_000, 30_000, 90_000);
const CHUNK_MAX_ARTICLES = boundedNumber(process.env.MONTHLY_ROLLUP_CHUNK_MAX_ARTICLES, 24, 5, 40);
const REDUCE_MAX_ITEMS = boundedNumber(process.env.MONTHLY_ROLLUP_REDUCE_MAX_ITEMS, 8, 2, 16);
const CALL_TIMEOUT_MS = boundedNumber(process.env.MONTHLY_ROLLUP_TIMEOUT_MS, 120_000, 30_000, 210_000);
const LEASE_SECONDS = boundedNumber(process.env.MONTHLY_ROLLUP_LEASE_SECONDS, 210, 60, 480);
const MAX_FAILURES = boundedNumber(process.env.MONTHLY_ROLLUP_MAX_FAILURES, 4, 1, 8);

class LeaseLostError extends Error {
  constructor() {
    super('monthly rollup lease lost');
    this.name = 'LeaseLostError';
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function list(value: unknown, max = 12) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function uniqueStrings(values: unknown[], max = Number.POSITIVE_INFINITY) {
  return Array.from(new Set(values.map(text).filter(Boolean))).slice(0, max);
}

function active(article: MonthlyRollupArticle) {
  return !article.status || !HIDDEN.has(article.status);
}

export function monthlyRollupMonthKey(value: unknown) {
  const date = text(value);
  const iso = date.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}`;
  const slash = date.match(/^(\d{4})\/(\d{1,2})/);
  if (slash) return `${slash[1]}-${slash[2].padStart(2, '0')}`;
  const jp = date.match(/^(\d{4})年\s*(\d{1,2})月/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, '0')}`;
  return 'undated';
}

function validateMonthKey(monthKey: string) {
  if (monthKey === 'undated') return;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) throw new Error('month_key must be YYYY-MM or undated');
}

function compactArticleText(value: unknown) {
  const normalized = text(value).replace(/\s+/g, ' ');
  if (normalized.length <= ARTICLE_TEXT_LIMIT) return normalized;
  const head = Math.floor(ARTICLE_TEXT_LIMIT * 0.72);
  return `${normalized.slice(0, head)} … ${normalized.slice(-(ARTICLE_TEXT_LIMIT - head))}`;
}

function compactArticle(article: MonthlyRollupArticle) {
  return {
    article_id: article.id,
    headline: article.headline || '',
    article_date: article.article_date || article.created_at || '',
    article_text: compactArticleText(article.ocr_text)
  };
}

function articleSortKey(article: MonthlyRollupArticle) {
  return `${article.article_date || article.created_at || ''}\u0000${article.id}`;
}

async function fetchAllArticles() {
  const rows: MonthlyRollupArticle[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('articles')
      .select('id,headline,article_date,ocr_text,status,created_at')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data || []) as MonthlyRollupArticle[]));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function articlesForMonth(monthKey: string) {
  validateMonthKey(monthKey);
  const rows = await fetchAllArticles();
  return rows
    .filter(active)
    .filter((article) => monthlyRollupMonthKey(article.article_date) === monthKey)
    .sort((a, b) => articleSortKey(a).localeCompare(articleSortKey(b)));
}

function sourceFingerprint(monthKey: string, articles: MonthlyRollupArticle[]) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    month_key: monthKey,
    worker_version: WORKER_VERSION,
    prompt_version: PROMPT_VERSION,
    model: MODEL,
    article_text_limit: ARTICLE_TEXT_LIMIT,
    request_char_budget: REQUEST_CHAR_BUDGET,
    chunk_max_articles: CHUNK_MAX_ARTICLES,
    reduce_max_items: REDUCE_MAX_ITEMS
  }));
  for (const article of articles) {
    hash.update('\n');
    hash.update(JSON.stringify(compactArticle(article)));
  }
  return hash.digest('hex');
}

function serializedChars(value: unknown) {
  return JSON.stringify(value).length;
}

function articleChunks(articles: MonthlyRollupArticle[]) {
  const chunks: MonthlyRollupArticle[][] = [];
  let current: MonthlyRollupArticle[] = [];
  let chars = 5000;
  for (const article of articles) {
    const nextChars = serializedChars(compactArticle(article)) + 24;
    if (current.length && (current.length >= CHUNK_MAX_ARTICLES || chars + nextChars > REQUEST_CHAR_BUDGET)) {
      chunks.push(current);
      current = [];
      chars = 5000;
    }
    current.push(article);
    chars += nextChars;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function compactNode(node: RollupNode) {
  return {
    node_id: node.node_id,
    source_article_count: node.source_article_count,
    source_article_ids: node.source_article_ids,
    summary_text: node.summary_text.slice(0, 4200),
    major_themes: node.major_themes.slice(0, 8),
    consumer_narrative: node.consumer_narrative.slice(0, 2200),
    weak_signals: node.weak_signals.slice(0, 6),
    contradictions: node.contradictions.slice(0, 6),
    research_needs: node.research_needs.slice(0, 6),
    evidence_matrix: node.evidence_matrix.slice(0, 12),
    representative_article_ids: node.representative_article_ids.slice(0, 24),
    evidence_article_ids: node.evidence_article_ids.slice(0, 40)
  };
}

function nodeGroups(nodes: RollupNode[]) {
  const groups: RollupNode[][] = [];
  let current: RollupNode[] = [];
  let chars = 5000;
  for (const node of nodes) {
    const nextChars = serializedChars(compactNode(node)) + 24;
    if (current.length && (current.length >= REDUCE_MAX_ITEMS || chars + nextChars > REQUEST_CHAR_BUDGET)) {
      groups.push(current);
      current = [];
      chars = 5000;
    }
    current.push(node);
    chars += nextChars;
  }
  if (current.length) groups.push(current);
  if (groups.length === nodes.length && nodes.length > 1) {
    const paired: RollupNode[][] = [];
    for (let index = 0; index < nodes.length; index += 2) paired.push(nodes.slice(index, index + 2));
    return paired;
  }
  return groups;
}

function parseEvidence(value: unknown, allowed: Set<string>, max = 24) {
  if (!Array.isArray(value)) return [] as EvidenceItem[];
  const rows: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const articleId = text(raw.article_id || raw.id);
    const observedFact = text(raw.observed_fact || raw.evidence_excerpt_or_fact || raw.excerpt || raw.fact);
    if (!articleId || !allowed.has(articleId) || observedFact.length < 20 || seen.has(articleId)) continue;
    seen.add(articleId);
    rows.push({
      article_id: articleId,
      observed_fact: observedFact.slice(0, 700),
      claim: text(raw.claim || raw.theme).slice(0, 300),
      limitation: text(raw.limitation).slice(0, 400),
      evidence_strength: text(raw.evidence_strength || raw.strength || 'B').slice(0, 20)
    });
    if (rows.length >= max) break;
  }
  return rows;
}

function buildNode(parsed: JsonRecord, sourceIds: string[], level: number, nodeId: string) {
  const allowed = new Set(sourceIds);
  const summaryText = text(parsed.summary_text || parsed.summary || parsed.consumer_narrative);
  if (summaryText.length < 80) throw new Error('monthly rollup LLM returned an insufficient summary_text');
  const evidenceMatrix = parseEvidence(parsed.evidence_matrix, allowed);
  const minimumEvidence = Math.min(3, sourceIds.length);
  if (evidenceMatrix.length < minimumEvidence) {
    throw new Error(`monthly rollup LLM returned insufficient grounded evidence: ${evidenceMatrix.length}/${minimumEvidence}`);
  }
  const evidenceIds = evidenceMatrix.map((item) => item.article_id);
  const representative = uniqueStrings(
    [...(Array.isArray(parsed.representative_article_ids) ? parsed.representative_article_ids : []), ...evidenceIds]
      .filter((id) => allowed.has(text(id))),
    40
  );
  return {
    node_id: nodeId,
    level,
    source_article_ids: sourceIds,
    source_article_count: sourceIds.length,
    summary_text: summaryText,
    major_themes: list(parsed.major_themes),
    consumer_narrative: text(parsed.consumer_narrative) || summaryText,
    weak_signals: list(parsed.weak_signals),
    contradictions: list(parsed.contradictions || parsed.refutation_notes),
    research_needs: list(parsed.research_needs),
    evidence_matrix: evidenceMatrix,
    representative_article_ids: representative.length ? representative : evidenceIds.slice(0, 40),
    evidence_article_ids: evidenceIds.slice(0, 80)
  } satisfies RollupNode;
}

function errorRecord(error: unknown) {
  return isRecord(error) ? error : {};
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  const record = errorRecord(error);
  return text(record.message || record.error || 'monthly rollup worker failed');
}

function retryable(error: unknown) {
  const record = errorRecord(error);
  const status = Number(record.status || record.statusCode || 0);
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

async function callJson(system: string, payload: JsonRecord, maxTokens: number) {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY is not configured');
  const content = JSON.stringify(payload);
  if (content.length > REQUEST_CHAR_BUDGET) {
    throw new Error(`monthly rollup preflight budget exceeded: ${content.length}/${REQUEST_CHAR_BUDGET} chars`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content }
      ]
    }, { signal: controller.signal });
    const raw = completion.choices[0]?.message.content || '';
    const parsed = JSON.parse(raw || '{}');
    if (!isRecord(parsed)) throw new Error('monthly rollup LLM returned non-object JSON');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeChunk(monthKey: string, chunk: MonthlyRollupArticle[], index: number, total: number) {
  const sourceIds = chunk.map((article) => article.id);
  const parsed = await callJson(
    'You are a strict consumer-insight analyst. Read every supplied article. Output only JSON. Every evidence item must use a supplied article_id and contain a concrete observed_fact of at least 20 characters. Never invent IDs or causal proof.',
    {
      task: 'Produce a grounded source-chunk summary for later formal monthly synthesis.',
      month_key: monthKey,
      chunk_index: index + 1,
      total_chunks: total,
      article_count: chunk.length,
      required_output: {
        summary_text: 'Grounded synthesis of all supplied articles.',
        major_themes: 'Observable themes.',
        consumer_narrative: 'Visible tension/change and uncertainty.',
        weak_signals: 'Emerging signals.',
        contradictions: 'Counter-readings and limiting evidence.',
        research_needs: 'Questions requiring primary research.',
        evidence_matrix: 'At least 3 items when 3+ articles exist; each has article_id, observed_fact, claim, limitation and evidence_strength.',
        representative_article_ids: 'Supplied article IDs only.'
      },
      articles: chunk.map(compactArticle)
    },
    2600
  );
  return buildNode(parsed, sourceIds, 0, `chunk-${index + 1}`);
}

async function synthesizeGroup(monthKey: string, group: RollupNode[], level: number, groupIndex: number, final: boolean) {
  const sourceIds = uniqueStrings(group.flatMap((node) => node.source_article_ids));
  const parsed = await callJson(
    'You are a strict synthesis analyst. Combine only supplied grounded summaries. Output only JSON. Preserve contradictions and uncertainty. Evidence must reuse supplied article IDs and concrete observed facts; never invent IDs.',
    {
      task: final
        ? 'Produce the formal monthly consumer-insight rollup from the supplied grounded summaries.'
        : 'Reduce the supplied grounded summaries into one smaller grounded synthesis.',
      month_key: monthKey,
      hierarchy_level: level,
      group_index: groupIndex + 1,
      final_monthly_synthesis: final,
      source_article_count: sourceIds.length,
      required_output: {
        summary_text: 'Grounded synthesis.',
        major_themes: 'Observable themes.',
        consumer_narrative: 'Visible tension/change and uncertainty.',
        weak_signals: 'Emerging signals.',
        contradictions: 'Counter-readings and limiting evidence.',
        research_needs: 'Questions requiring primary research.',
        evidence_matrix: 'At least 3 grounded items with article_id and observed_fact.',
        representative_article_ids: 'IDs present in supplied summaries only.'
      },
      source_summaries: group.map(compactNode)
    },
    final ? 4200 : 2800
  );
  return buildNode(parsed, sourceIds, level, `level-${level}-group-${groupIndex + 1}`);
}

function validNode(value: unknown): value is RollupNode {
  if (!isRecord(value)) return false;
  return Boolean(
    text(value.node_id)
    && Number.isFinite(Number(value.level))
    && Array.isArray(value.source_article_ids)
    && text(value.summary_text)
    && Array.isArray(value.evidence_matrix)
  );
}

function parseState(value: unknown, fingerprint: string, totalChunks: number): WorkerState | null {
  if (!isRecord(value)) return null;
  if (value.worker_version !== WORKER_VERSION || value.prompt_version !== PROMPT_VERSION) return null;
  if (text(value.source_fingerprint) !== fingerprint || Number(value.total_chunks) !== totalChunks) return null;
  const chunks = Array.isArray(value.chunks) ? value.chunks.filter(validNode) : [];
  const currentNodes = Array.isArray(value.current_nodes) ? value.current_nodes.filter(validNode) : [];
  const nextNodes = Array.isArray(value.next_nodes) ? value.next_nodes.filter(validNode) : [];
  const phase = value.phase === 'reduce' ? 'reduce' : 'chunks';
  return {
    generation_method: 'hierarchical_llm_worker',
    worker_version: WORKER_VERSION,
    prompt_version: PROMPT_VERSION,
    source_fingerprint: fingerprint,
    phase,
    total_chunks: totalChunks,
    completed_chunks: chunks.length,
    chunks,
    current_level: Math.max(1, Number(value.current_level || 1)),
    current_nodes: currentNodes,
    next_nodes: nextNodes,
    next_group_index: Math.max(0, Number(value.next_group_index || 0)),
    request_char_budget: REQUEST_CHAR_BUDGET,
    article_text_limit: ARTICLE_TEXT_LIMIT,
    chunk_max_articles: CHUNK_MAX_ARTICLES,
    reduce_max_items: REDUCE_MAX_ITEMS,
    model: MODEL
  };
}

function initialState(fingerprint: string, totalChunks: number): WorkerState {
  return {
    generation_method: 'hierarchical_llm_worker',
    worker_version: WORKER_VERSION,
    prompt_version: PROMPT_VERSION,
    source_fingerprint: fingerprint,
    phase: 'chunks',
    total_chunks: totalChunks,
    completed_chunks: 0,
    chunks: [],
    current_level: 1,
    current_nodes: [],
    next_nodes: [],
    next_group_index: 0,
    request_char_budget: REQUEST_CHAR_BUDGET,
    article_text_limit: ARTICLE_TEXT_LIMIT,
    chunk_max_articles: CHUNK_MAX_ARTICLES,
    reduce_max_items: REDUCE_MAX_ITEMS,
    model: MODEL
  };
}

function progress(state: WorkerState) {
  if (state.phase === 'chunks') {
    return Math.max(1, Math.min(75, Math.round((state.completed_chunks / Math.max(1, state.total_chunks)) * 75)));
  }
  const groups = nodeGroups(state.current_nodes);
  const groupProgress = groups.length ? state.next_group_index / groups.length : 0;
  return Math.max(76, Math.min(98, Math.round(76 + groupProgress * 22)));
}

async function updateClaimed(row: RollupRow, patch: JsonRecord, releaseLease = true) {
  const token = text(row.lease_token);
  if (!token) throw new LeaseLostError();
  const now = new Date();
  const payload: JsonRecord = {
    ...patch,
    heartbeat_at: now.toISOString(),
    updated_at: now.toISOString(),
    lease_expires_at: releaseLease ? null : new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString()
  };
  if (releaseLease) payload.lease_token = null;
  const { data, error } = await supabaseAdmin
    .from('monthly_rollups')
    .update(payload)
    .eq('id', row.id)
    .eq('lease_token', token)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new LeaseLostError();
  return data as RollupRow;
}

async function claim(monthKey?: string) {
  const rpc = monthKey ? 'claim_monthly_rollup' : 'claim_next_monthly_rollup';
  const args = monthKey
    ? { p_month_key: monthKey, p_lease_seconds: LEASE_SECONDS }
    : { p_lease_seconds: LEASE_SECONDS };
  const { data, error } = await supabaseAdmin.rpc(rpc, args);
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return isRecord(row) ? row as RollupRow : null;
}

export async function enqueueMonthlyRollup(monthKey: string, force = false) {
  validateMonthKey(monthKey);
  const { data, error } = await supabaseAdmin.rpc('enqueue_monthly_rollup', {
    p_month_key: monthKey,
    p_force: force
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) throw new Error('enqueue_monthly_rollup returned no row');
  return row as RollupRow;
}

export async function kickMonthlyRollupWorker() {
  const { data, error } = await supabaseAdmin.rpc('kick_monthly_rollup_worker');
  if (error) throw error;
  return data;
}

async function latestFingerprint(monthKey: string) {
  const articles = await articlesForMonth(monthKey);
  return { articles, fingerprint: sourceFingerprint(monthKey, articles) };
}

async function executeStep(row: RollupRow) {
  const monthKey = row.month_key;
  const { articles, fingerprint } = await latestFingerprint(monthKey);
  const chunks = articleChunks(articles);
  const articleIds = articles.map((article) => article.id);
  const latestDate = articles
    .map((article) => article.article_date || article.created_at || '')
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  if (!articles.length) {
    const ready = await updateClaimed(row, {
      article_count: 0,
      article_ids: [],
      source_latest_article_at: null,
      rollup_model: 'empty_rollup_v2',
      status: 'ready',
      summary_text: `${monthKey} has no source articles.`,
      summary_json: {
        month_key: monthKey,
        article_count: 0,
        source_fingerprint: fingerprint,
        generation_method: 'empty',
        rollup_analysis_is_validated: true,
        fallback_used: false
      },
      representative_article_ids: [],
      evidence_article_ids: [],
      error_message: null,
      generated_at: new Date().toISOString(),
      attempt_count: 0,
      next_retry_at: null
    });
    return { status: 'ready', rollup: ready, step: 'empty' };
  }

  let state = parseState(row.summary_json, fingerprint, chunks.length) || initialState(fingerprint, chunks.length);

  if (state.phase === 'chunks') {
    const index = state.chunks.length;
    if (index < chunks.length) {
      const node = await synthesizeChunk(monthKey, chunks[index], index, chunks.length);
      const expectedIds = chunks[index].map((article) => article.id);
      if (JSON.stringify(node.source_article_ids) !== JSON.stringify(expectedIds)) {
        throw new Error('monthly rollup chunk source coverage mismatch');
      }
      state = { ...state, chunks: [...state.chunks, node], completed_chunks: index + 1 };
    }
    if (state.chunks.length === chunks.length) {
      state = {
        ...state,
        phase: 'reduce',
        current_level: 1,
        current_nodes: state.chunks,
        next_nodes: [],
        next_group_index: 0
      };
    }
    const queued = await updateClaimed(row, {
      article_count: articles.length,
      article_ids: articleIds,
      source_latest_article_at: latestDate,
      rollup_model: MODEL,
      status: 'queued',
      summary_text: state.phase === 'chunks'
        ? `Monthly rollup source chunks: ${state.completed_chunks}/${state.total_chunks} completed.`
        : 'Monthly rollup source chunks complete; hierarchical synthesis queued.',
      summary_json: state,
      error_message: null,
      attempt_count: 0,
      next_retry_at: null
    });
    return { status: 'queued', rollup: queued, progress: progress(state), step: 'chunk' };
  }

  const groups = nodeGroups(state.current_nodes);
  if (!groups.length) throw new Error('monthly rollup reduction has no source groups');
  const groupIndex = state.next_group_index;
  if (groupIndex >= groups.length) throw new Error('monthly rollup reduction index is invalid');
  const final = groups.length === 1;
  const node = await synthesizeGroup(monthKey, groups[groupIndex], state.current_level, groupIndex, final);

  if (final) {
    const refreshed = await latestFingerprint(monthKey);
    if (refreshed.fingerprint !== fingerprint) {
      const reset = initialState(refreshed.fingerprint, articleChunks(refreshed.articles).length);
      const queued = await updateClaimed(row, {
        article_count: refreshed.articles.length,
        article_ids: refreshed.articles.map((article) => article.id),
        rollup_model: MODEL,
        status: 'queued',
        summary_text: 'Source articles changed during synthesis; restarting from the new source fingerprint.',
        summary_json: reset,
        representative_article_ids: [],
        evidence_article_ids: [],
        error_message: null,
        generated_at: null,
        attempt_count: 0,
        next_retry_at: null
      });
      return { status: 'queued', rollup: queued, progress: 1, step: 'source_changed_restart' };
    }

    const allowed = new Set(articleIds);
    const evidenceMatrix = node.evidence_matrix.filter((item) => allowed.has(item.article_id));
    const minimumEvidence = Math.min(3, articles.length);
    if (evidenceMatrix.length < minimumEvidence) {
      throw new Error(`formal monthly rollup evidence gate failed: ${evidenceMatrix.length}/${minimumEvidence}`);
    }
    const evidenceIds = uniqueStrings(evidenceMatrix.map((item) => item.article_id), 80);
    const representativeIds = uniqueStrings(
      [...node.representative_article_ids, ...evidenceIds].filter((id) => allowed.has(id)),
      40
    );
    const ready = await updateClaimed(row, {
      article_count: articles.length,
      article_ids: articleIds,
      source_latest_article_at: latestDate,
      rollup_model: MODEL,
      status: 'ready',
      summary_text: node.summary_text,
      summary_json: {
        month_key: monthKey,
        article_count: articles.length,
        summary_text: node.summary_text,
        major_themes: node.major_themes,
        consumer_narrative: node.consumer_narrative,
        weak_signals: node.weak_signals,
        contradictions: node.contradictions,
        research_needs: node.research_needs,
        evidence_matrix: evidenceMatrix,
        representative_article_ids: representativeIds,
        evidence_article_ids: evidenceIds,
        source_article_ids: articleIds,
        source_fingerprint: fingerprint,
        source_chunk_count: chunks.length,
        hierarchy_levels: state.current_level,
        generation_method: 'hierarchical_llm_worker',
        worker_version: WORKER_VERSION,
        prompt_version: PROMPT_VERSION,
        request_char_budget: REQUEST_CHAR_BUDGET,
        article_text_limit: ARTICLE_TEXT_LIMIT,
        rollup_analysis_is_validated: true,
        fallback_used: false
      },
      representative_article_ids: representativeIds,
      evidence_article_ids: evidenceIds,
      error_message: null,
      generated_at: new Date().toISOString(),
      attempt_count: 0,
      next_retry_at: null
    });
    return { status: 'ready', rollup: ready, progress: 100, step: 'final' };
  }

  const nextNodes = [...state.next_nodes, node];
  let nextState: WorkerState;
  if (groupIndex + 1 >= groups.length) {
    nextState = {
      ...state,
      current_level: state.current_level + 1,
      current_nodes: nextNodes,
      next_nodes: [],
      next_group_index: 0
    };
  } else {
    nextState = {
      ...state,
      next_nodes: nextNodes,
      next_group_index: groupIndex + 1
    };
  }
  const queued = await updateClaimed(row, {
    article_count: articles.length,
    article_ids: articleIds,
    source_latest_article_at: latestDate,
    rollup_model: MODEL,
    status: 'queued',
    summary_text: `Monthly rollup hierarchy level ${state.current_level}: ${groupIndex + 1}/${groups.length} groups completed.`,
    summary_json: nextState,
    error_message: null,
    attempt_count: 0,
    next_retry_at: null
  });
  return { status: 'queued', rollup: queued, progress: progress(nextState), step: 'reduce' };
}

export async function runMonthlyRollupWorkerStep(monthKey?: string) {
  if (monthKey) validateMonthKey(monthKey);
  const claimed = await claim(monthKey);
  if (!claimed) return { status: 'idle', claimed: false };
  try {
    return { claimed: true, ...(await executeStep(claimed)) };
  } catch (error) {
    if (error instanceof LeaseLostError) return { status: 'lease_lost', claimed: true, error: error.message };
    const message = errorMessage(error);
    const nextAttempt = Math.max(0, Number(claimed.attempt_count || 0)) + 1;
    if (retryable(error) && nextAttempt <= MAX_FAILURES) {
      const delaySeconds = Math.min(600, 20 * (2 ** (nextAttempt - 1)));
      const queued = await updateClaimed(claimed, {
        status: 'queued',
        error_message: message,
        attempt_count: nextAttempt,
        next_retry_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
        summary_text: `Transient error; retry scheduled in ${delaySeconds} seconds.`
      });
      return { status: 'queued', claimed: true, retry_scheduled: true, retry_after_seconds: delaySeconds, error: message, rollup: queued };
    }
    const failed = await updateClaimed(claimed, {
      status: 'failed',
      error_message: message,
      attempt_count: nextAttempt,
      next_retry_at: null,
      summary_text: 'Monthly rollup generation failed. No extractive fallback was accepted as formal.',
      generated_at: null
    });
    return { status: 'failed', claimed: true, error: message, rollup: failed };
  }
}

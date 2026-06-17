import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI } from '@/lib/openai';
import { fetchAllWideArticles, type WideArticle } from '@/lib/wideArticleRetrieval';

type JsonRecord = Record<string, unknown>;

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
  analyzed_article_count: number;
  coverage_json: JsonRecord;
  error_message: string | null;
};

type ScanBatch = {
  id: string;
  run_id: string;
  batch_index: number;
  article_ids: string[];
  article_count: number;
  status: string;
  model: string;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeJson(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : { raw: parsed };
  } catch {
    return { raw_text: value };
  }
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
    text: (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, 3500)
  };
}

function fallbackBatchSummary(articles: WideArticle[], reason: string) {
  const evidence = articles.slice(0, 10).map((article) => ({
    article_id: article.id,
    headline: article.headline || '無題の記事',
    article_date: article.article_date || '日付不明',
    observed_fact: (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, 220),
    limitation: 'fallback extractive summary; not a model-based interpretation'
  }));

  return {
    scan_type: 'full_corpus_batch',
    prompt_version: 'full_corpus_batch_v1',
    analysis_is_validated: false,
    fallback_reason: reason,
    article_count: articles.length,
    read_article_ids: articles.map((article) => article.id),
    consumer_narratives: [],
    behavior_signals: [],
    constraints: [],
    contradictions: [],
    category_signals: [],
    weak_signals: [],
    research_needs: [{
      question: 'このバッチは抽出的fallbackのため、生活者ナラティブの解釈を再読解する必要がある。',
      why_it_matters: '本文を意味読解していないため。',
      priority: 'high'
    }],
    evidence
  };
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

async function analyzeBatch(articles: WideArticle[], model: string, scopeType: string, scopeQuery: string) {
  const openai = getOpenAI();
  if (!openai) return fallbackBatchSummary(articles, 'OPENAI_API_KEY is not configured');

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

  try {
    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a strict consumer-insight analyst. Read all supplied article texts. Output only JSON. Never claim full-corpus coverage beyond this batch.' },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    });
    const content = completion.choices[0]?.message.content || '{}';
    const parsed = safeJson(content);
    parsed.scan_type = 'full_corpus_batch';
    parsed.prompt_version = 'full_corpus_batch_v1';
    parsed.model_used = model;
    parsed.article_count = articles.length;
    parsed.read_article_ids = Array.isArray(parsed.read_article_ids) ? parsed.read_article_ids : articles.map((article) => article.id);
    return parsed;
  } catch (error) {
    return fallbackBatchSummary(articles, error instanceof Error ? error.message : 'batch analysis failed');
  }
}

export async function createFullCorpusScanRun(input: { scope_type?: string; scope_query?: string; model?: string; batch_size?: number }) {
  const scopeType = input.scope_type === 'category' ? 'category' : 'all';
  const scopeQuery = text(input.scope_query);
  const model = text(input.model) || process.env.OPENAI_SCAN_MODEL || 'gpt-4o-mini';
  const batchSize = Math.max(5, Math.min(50, Math.round(Number(input.batch_size || 30))));

  const all = await fetchAllWideArticles();
  const scoped = all.filter((article) => matchesScope(article, scopeType, scopeQuery));
  const ocrReady = scoped.filter((article) => text(article.ocr_text));
  const batches = chunk(ocrReady, batchSize);

  const { data: run, error } = await supabaseAdmin
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
      coverage_json: {
        active_article_count: scoped.length,
        ocr_ready_article_count: ocrReady.length,
        missing_ocr_count: scoped.length - ocrReady.length,
        batch_size: batchSize,
        total_batches: batches.length,
        full_corpus_gate: batches.length && scoped.length === ocrReady.length ? 'pending' : 'failed'
      },
      error_message: batches.length ? null : 'No OCR-ready articles matched this scan scope.'
    })
    .select('*')
    .single();
  if (error) throw error;

  const batchRows = batches.map((articles, index) => ({
    run_id: run.id,
    batch_index: index + 1,
    article_ids: articles.map((article) => article.id),
    article_count: articles.length,
    status: 'queued',
    model
  }));

  if (batchRows.length) {
    const { error: batchError } = await supabaseAdmin.from('full_corpus_scan_batches').insert(batchRows);
    if (batchError) throw batchError;
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
    .select('id, run_id, batch_index, article_count, status, model, error_message, created_at, updated_at, started_at, finished_at')
    .eq('run_id', id)
    .order('batch_index', { ascending: true });
  if (batchError) throw batchError;

  return { run: run as ScanRun, batches: batches || [] };
}

export async function getLatestFullCorpusScanRun(scopeType = 'all', scopeQuery = '') {
  let query = supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('scope_type', scopeType)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (scopeQuery) query = supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('scope_type', scopeType)
    .eq('scope_query', scopeQuery)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await query;
  if (error) throw error;
  return data as ScanRun | null;
}

export async function runFullCorpusScanBatches(id: string, maxBatches = 2) {
  const { data: run, error } = await supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  if (!run) throw new Error('full corpus scan run not found');

  if (run.status === 'completed') return getFullCorpusScanRun(id);

  await supabaseAdmin
    .from('full_corpus_scan_runs')
    .update({ status: 'running', started_at: run.started_at || new Date().toISOString(), updated_at: new Date().toISOString(), error_message: null })
    .eq('id', id);

  const { data: batches, error: batchError } = await supabaseAdmin
    .from('full_corpus_scan_batches')
    .select('*')
    .eq('run_id', id)
    .in('status', ['queued', 'failed'])
    .order('batch_index', { ascending: true })
    .limit(Math.max(1, Math.min(10, Math.round(maxBatches))));
  if (batchError) throw batchError;

  for (const batch of (batches || []) as ScanBatch[]) {
    await supabaseAdmin
      .from('full_corpus_scan_batches')
      .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: null })
      .eq('id', batch.id);

    try {
      const articles = await loadArticlesByIds(batch.article_ids);
      const summary = await analyzeBatch(articles, batch.model || run.model, run.scope_type, run.scope_query || '');
      const evidenceIds = evidenceIdsFromSummary(summary, batch.article_ids);
      await supabaseAdmin
        .from('full_corpus_scan_batches')
        .update({
          status: 'completed',
          summary_json: summary,
          evidence_article_ids: evidenceIds,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          error_message: null
        })
        .eq('id', batch.id);
    } catch (error) {
      await supabaseAdmin
        .from('full_corpus_scan_batches')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'batch failed',
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', batch.id);
    }
  }

  const latest = await getFullCorpusScanRun(id);
  const done = latest.run.completed_batches === latest.run.total_batches && latest.run.total_batches > 0;
  const failed = latest.run.failed_batches > 0;
  const nextStatus = done ? 'completed' : failed ? 'needs_review' : 'running';
  const fullCorpusGate = done && latest.run.analyzed_article_count === latest.run.ocr_ready_article_count ? 'passed' : 'failed';

  await supabaseAdmin
    .from('full_corpus_scan_runs')
    .update({
      status: nextStatus,
      finished_at: done ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
      coverage_json: {
        ...(latest.run.coverage_json || {}),
        completed_batches: latest.run.completed_batches,
        failed_batches: latest.run.failed_batches,
        analyzed_article_count: latest.run.analyzed_article_count,
        full_corpus_gate: fullCorpusGate
      }
    })
    .eq('id', id);

  return getFullCorpusScanRun(id);
}

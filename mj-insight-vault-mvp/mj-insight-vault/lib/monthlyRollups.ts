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
  status: 'ready' | 'stale' | 'running' | 'failed' | string;
  summary_text: string;
  summary_json: Record<string, unknown> | null;
  representative_article_ids: string[] | null;
  evidence_article_ids: string[] | null;
  error_message: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
};

export const UNDATED_MONTH_KEY = 'undated';

const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const SELECT = 'id, headline, article_date, ocr_text, status, created_at';
const PAGE_SIZE = 1000;
const RUNNING_LOCK_MS = 10 * 60 * 1000;
const MONTH_BATCH_LIMIT = Number(process.env.MONTHLY_ROLLUP_BATCH_LIMIT || 3);

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
    return !rollup || rollup.status === 'stale' || rollup.status === 'failed';
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
  for (const month of months) {
    results.push(await generateMonthlyRollup(month));
  }
  return results;
}

export async function generateNeededMonthlyRollups(limit?: number) {
  const months = (await listNeededRollupMonths()).slice(0, boundedBatchLimit(limit));
  const results: MonthlyRollupRow[] = [];
  for (const month of months) {
    results.push(await generateMonthlyRollup(month));
  }
  return results;
}

function buildFallbackRollup(monthKey: string, articles: RollupArticle[], reason: string) {
  const representative = articles.slice(0, 40).map((article) => article.id);
  const evidence = articles.slice(0, 80).map((article) => article.id);
  const topLines = articles.slice(0, 30).map((article, index) => `${index + 1}. ${articleLink(article)}: ${(article.ocr_text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  const label = monthLabel(monthKey);
  const summary = [
    `## ${label} monthly rollup (extractive fallback)`,
    `Source articles: ${articles.length}. ${reason}`,
    '',
    '## Evidence candidates',
    topLines.join('\n') || 'No evidence candidates',
    '',
    '## Limitation',
    'This is an extractive fallback. All article IDs are preserved, but semantic synthesis, refutation, and WHY analysis are weaker than a normal LLM monthly rollup.'
  ].join('\n');
  return {
    summary,
    summaryJson: {
      month_key: monthKey,
      month_label: label,
      summary_text: summary,
      major_themes: ['extractive fallback; themes not synthesized'],
      consumer_narrative: 'Article IDs and representative evidence only.',
      weak_signals: [],
      evidence_matrix: topLines,
      refutation_notes: [reason],
      research_needs: ['Regenerate this month with normal LLM synthesis and compare against the fallback.'],
      representative_article_ids: representative,
      evidence_article_ids: evidence,
      generation_warning: 'extractive_fallback_rollup'
    },
    representative,
    evidence
  };
}

export async function generateMonthlyRollup(monthKey: string) {
  validateMonthKey(monthKey);
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('monthly_rollups')
    .select('*')
    .eq('month_key', monthKey)
    .maybeSingle();
  if (existingError) throw existingError;
  if (isFreshRunningRollup(existing as MonthlyRollupRow | null)) return existing as MonthlyRollupRow;

  const articles = await getArticlesForMonth(monthKey);
  const articleIds = articles.map((article) => article.id);
  const latestDate = articles.map((article) => article.article_date || article.created_at || '').filter(Boolean).sort().at(-1) || null;

  if (!articles.length) {
    return upsertMonthlyRollup(monthKey, 0, [], null, 'extractive_fallback', `${monthLabel(monthKey)} has no source articles.`, { month_key: monthKey, article_count: 0 }, [], [], 'ready', null);
  }

  let synthesisError = 'OPENAI_API_KEY is not configured';
  if (getOpenAI()) {
    try {
      const synthesized = await synthesizeMonthlyRollup(monthKey, articles);
      if (synthesized) {
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
      }
    } catch (error) {
      synthesisError = error instanceof Error ? error.message : 'monthly rollup LLM synthesis failed';
    }
  }

  const fallback = buildFallbackRollup(monthKey, articles, 'LLM synthesis unavailable: ' + synthesisError);
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
    'extractive fallback is not valid as a formal monthly rollup; ' + synthesisError
  );
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
type RollupJson = Record<string, unknown>;

const ROLLUP_ARTICLE_TEXT_LIMIT = 1600;
const ROLLUP_MODEL = process.env.OPENAI_ROLLUP_MODEL || TEXT_MODEL;

function rollupText(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function rollupList(value: unknown, max = 12) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function allowedArticleIds(value: unknown, allowed: Set<string>) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(rollupText).filter((id) => allowed.has(id))));
}

async function synthesizeMonthlyRollup(monthKey: string, articles: RollupArticle[]) {
  const openai = getOpenAI();
  if (!openai) return null;

  const articleIds = articles.map((article) => article.id);
  const allowed = new Set(articleIds);
  const payload = {
    task: 'Read every supplied article and synthesize a monthly consumer-insight rollup. Do not infer causality from article coverage alone.',
    month_key: monthKey,
    article_count: articles.length,
    required_output: {
      summary_text: 'A concise synthesis grounded in the supplied article texts.',
      major_themes: 'Array of observable themes with concrete wording.',
      consumer_narrative: 'What consumer change or tension is visible, and what remains uncertain.',
      weak_signals: 'Small or emerging signals, not generic trend labels.',
      contradictions: 'Counter-readings or evidence that weakens simple conclusions.',
      research_needs: 'Questions that require primary research.',
      evidence_matrix: 'Evidence items with article_id and observed_fact.',
      representative_article_ids: 'IDs from the supplied articles only.',
      evidence_article_ids: 'IDs from the supplied articles only.'
    },
    articles: articles.map((article) => ({
      article_id: article.id,
      headline: article.headline || '',
      article_date: article.article_date || article.created_at || '',
      article_text: (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, ROLLUP_ARTICLE_TEXT_LIMIT)
    }))
  };

  const completion = await openai.chat.completions.create({
    model: ROLLUP_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are a strict consumer-insight analyst. Read every supplied article text. Output only JSON. Separate observed facts, interpretation, contradictions, and research needs. Never invent article IDs or claim that an article proves causality.'
      },
      { role: 'user', content: JSON.stringify(payload) }
    ]
  });

  const parsedText = completion.choices[0]?.message.content || '{}';
  let parsed: RollupJson;
  try {
    parsed = JSON.parse(parsedText) as RollupJson;
  } catch {
    throw new Error('monthly rollup LLM returned invalid JSON');
  }

  const summary = rollupText(parsed.summary_text || parsed.summary || parsed.consumer_narrative);
  if (!summary) throw new Error('monthly rollup LLM returned no summary_text');

  const representative = allowedArticleIds(parsed.representative_article_ids, allowed);
  const evidence = allowedArticleIds(parsed.evidence_article_ids, allowed);
  const representativeIds = representative.length ? representative : articleIds.slice(0, 40);
  const evidenceIds = evidence.length ? evidence : articleIds.slice(0, 80);

  return {
    model: ROLLUP_MODEL,
    summary,
    summaryJson: {
      month_key: monthKey,
      month_label: monthLabel(monthKey),
      article_count: articles.length,
      summary_text: summary,
      major_themes: rollupList(parsed.major_themes),
      consumer_narrative: rollupText(parsed.consumer_narrative) || summary,
      weak_signals: rollupList(parsed.weak_signals),
      contradictions: rollupList(parsed.contradictions || parsed.refutation_notes),
      research_needs: rollupList(parsed.research_needs),
      evidence_matrix: rollupList(parsed.evidence_matrix, 20),
      representative_article_ids: representativeIds,
      evidence_article_ids: evidenceIds,
      source_article_ids: articleIds,
      rollup_analysis_is_validated: true,
      generation_method: 'llm'
    },
    representative: representativeIds,
    evidence: evidenceIds
  };
}

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

const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const SELECT = 'id, headline, article_date, ocr_text, status, created_at';
const PAGE_SIZE = 1000;
const RUNNING_LOCK_MS = 10 * 60 * 1000;
const ROLLUP_TIMEOUT_MS = 80000;
const MONTH_BATCH_LIMIT = Number(process.env.MONTHLY_ROLLUP_BATCH_LIMIT || 3);

function active(article: RollupArticle) {
  return !article.status || !HIDDEN.has(article.status);
}

function monthRange(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) throw new Error('month_key must be YYYY-MM');
  const start = `${monthKey}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { start, end: nextMonth };
}

export function monthKeyFromDate(value: unknown) {
  const date = String(value || '').trim();
  const iso = date.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}`;
  const slash = date.match(/^(\d{4})\/(\d{1,2})/);
  if (slash) return `${slash[1]}-${slash[2].padStart(2, '0')}`;
  const jp = date.match(/^(\d{4})年\s*(\d{1,2})月/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, '0')}`;
  return '';
}

function articleBelongsToMonth(article: RollupArticle, monthKey: string) {
  return monthKeyFromDate(article.article_date) === monthKey;
}

function articleSortKey(article: RollupArticle) {
  return String(article.article_date || article.created_at || '');
}

function articleLink(article: RollupArticle) {
  return `[${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}](/articles/${article.id})`;
}

function textLimit(count: number) {
  if (count > 500) return 120;
  if (count > 300) return 160;
  if (count > 180) return 220;
  if (count > 120) return 300;
  if (count > 80) return 450;
  if (count > 40) return 650;
  return 1000;
}

function rollupModel() {
  return (process.env.OPENAI_ROLLUP_MODEL || TEXT_MODEL || 'gpt-4o-mini').trim();
}

function rollupModelCandidates(primary: string) {
  return Array.from(new Set([
    primary,
    process.env.OPENAI_FINAL_FALLBACK_MODEL?.trim(),
    TEXT_MODEL,
    'gpt-4o-mini',
    'gpt-4.1-mini'
  ].filter(Boolean) as string[]));
}

function isFreshRunningRollup(rollup: MonthlyRollupRow | null) {
  if (!rollup || rollup.status !== 'running') return false;
  const updatedAt = Date.parse(String(rollup.updated_at || ''));
  if (!updatedAt || Number.isNaN(updatedAt)) return false;
  return Date.now() - updatedAt < RUNNING_LOCK_MS;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }).catch((error) => { clearTimeout(timer); reject(error); });
  });
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
  monthRange(monthKey);
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
    const monthKey = monthKeyFromDate(row.article_date);
    if (monthKey) months.add(monthKey);
  }
  return Array.from(months).sort().reverse();
}

export async function listArticleMonthCounts() {
  const data = await fetchAllRollupArticles('id, article_date, status, created_at');

  const counts: Record<string, number> = {};
  for (const row of data) {
    if (row.status && HIDDEN.has(row.status)) continue;
    const monthKey = monthKeyFromDate(row.article_date);
    if (!monthKey) continue;
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
  const months = Array.from(new Set(articleDates.map(monthKeyFromDate).filter(Boolean)));
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
  const results = [];
  for (const month of months) {
    results.push(await generateMonthlyRollup(month));
  }
  return results;
}

export async function generateNeededMonthlyRollups(limit?: number) {
  const months = (await listNeededRollupMonths()).slice(0, boundedBatchLimit(limit));
  const results = [];
  for (const month of months) {
    results.push(await generateMonthlyRollup(month));
  }
  return results;
}

function buildFallbackRollup(monthKey: string, articles: RollupArticle[], model: string, errorMessage: string) {
  const representative = articles.slice(0, 40).map((article) => article.id);
  const evidence = articles.slice(0, 80).map((article) => article.id);
  const topLines = articles.slice(0, 30).map((article, index) => `${index + 1}. ${articleLink(article)}：${(article.ocr_text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  const summary = [
    `## ${monthKey} 月別まとめ（抽出型・暫定）`,
    `対象記事${articles.length}件。LLMによる月別統合生成が失敗したため、全記事IDを保存し、見出し・冒頭抜粋から暫定rollupを作成しました。`,
    '',
    '## 代表記事候補',
    topLines.join('\n') || '代表記事候補なし',
    '',
    '## 限界',
    'この月別まとめは抽出型フォールバックです。全記事はカバーしていますが、意味統合・反証・WHY分析の品質は通常の月別rollupより低いです。'
  ].join('\n');
  return {
    summary,
    summaryJson: {
      summary_text: summary,
      major_themes: ['抽出型フォールバックのため、主要テーマは未統合'],
      consumer_narrative: 'LLM統合失敗。全記事ID・代表記事候補のみ保持。',
      weak_signals: [],
      evidence_matrix: topLines,
      refutation_notes: [`LLM統合失敗: ${errorMessage}`],
      research_needs: ['通常rollupを再生成し、抽出型フォールバックの読みを検証する'],
      representative_article_ids: representative,
      evidence_article_ids: evidence,
      generation_warning: 'extractive_fallback_rollup',
      generation_error: errorMessage,
      attempted_model: model
    },
    representative,
    evidence
  };
}

export async function generateMonthlyRollup(monthKey: string) {
  monthRange(monthKey);
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('monthly_rollups')
    .select('*')
    .eq('month_key', monthKey)
    .maybeSingle();
  if (existingError) throw existingError;
  if (isFreshRunningRollup(existing as MonthlyRollupRow | null)) return existing as MonthlyRollupRow;

  const articles = await getArticlesForMonth(monthKey);
  const model = rollupModel();
  const openai = getOpenAI();
  const articleIds = articles.map((article) => article.id);
  const latestDate = articles.map((article) => article.article_date || article.created_at || '').filter(Boolean).sort().at(-1) || null;

  if (!articles.length) {
    return upsertMonthlyRollup(monthKey, 0, [], null, model, `${monthKey}の対象記事はありません。`, { month_key: monthKey, article_count: 0 }, [], [], 'ready', null);
  }

  if (!openai) {
    const fallback = buildFallbackRollup(monthKey, articles, model, 'OPENAI_API_KEY missing');
    return upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, 'extractive_fallback', fallback.summary, fallback.summaryJson, fallback.representative, fallback.evidence, 'ready', 'OPENAI_API_KEY missing; extractive fallback saved');
  }

  await upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, model, '', {}, [], [], 'running', null);

  const limit = textLimit(articles.length);
  const articlePayload = articles.map((article, index) => ({
    no: index + 1,
    article_id: article.id,
    article_link: articleLink(article),
    headline: article.headline,
    article_date: article.article_date || '日付不明',
    text: (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, limit)
  }));

  const system = [
    'Return JSON only.',
    'You create a monthly intelligence rollup for accumulated Nikkei MJ articles.',
    'You must treat the supplied article list as the full monthly corpus, even when each article text is shortened.',
    'Do not write generic summaries. Preserve weak signals, contradictions, and research opportunities.',
    'Required keys: summary_text, major_themes, consumer_narrative, weak_signals, evidence_matrix, refutation_notes, research_needs, representative_article_ids, evidence_article_ids, next_month_watchpoints.',
    'Use article_link when citing evidence. Mark weak interpretations as hypotheses.'
  ].join('\n');

  const errors: string[] = [];
  for (const candidateModel of rollupModelCandidates(model)) {
    try {
      const completion = await withTimeout(openai.chat.completions.create({
        model: candidateModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify({ month_key: monthKey, article_count: articles.length, article_text_limit: limit, articles: articlePayload }) }
        ]
      }), ROLLUP_TIMEOUT_MS, `monthly rollup generation (${candidateModel})`);
      const raw = completion.choices[0]?.message.content || '{}';
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const summary = typeof parsed.summary_text === 'string' ? parsed.summary_text : raw;
      const representative = Array.isArray(parsed.representative_article_ids) ? parsed.representative_article_ids.map(String).filter(Boolean) : [];
      const evidence = Array.isArray(parsed.evidence_article_ids) ? parsed.evidence_article_ids.map(String).filter(Boolean) : representative;
      return upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, candidateModel, summary, parsed, representative, evidence, 'ready', null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'monthly rollup failed';
      errors.push(`${candidateModel}: ${message}`);
    }
  }

  const message = errors.join(' / ') || 'monthly rollup failed';
  const fallback = buildFallbackRollup(monthKey, articles, model, message);
  return upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, 'extractive_fallback', fallback.summary, fallback.summaryJson, fallback.representative, fallback.evidence, 'ready', message);
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
      generated_at: status === 'ready' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'month_key' })
    .select('*')
    .single();
  if (error) throw error;
  return data as MonthlyRollupRow;
}

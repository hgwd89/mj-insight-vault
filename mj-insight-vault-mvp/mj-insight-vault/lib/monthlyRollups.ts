import { supabaseAdmin } from '@/lib/supabaseAdmin';

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
const MONTH_BATCH_LIMIT = Number(process.env.MONTHLY_ROLLUP_BATCH_LIMIT || 3);

function active(article: RollupArticle) {
  return !article.status || !HIDDEN.has(article.status);
}

function monthRange(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) throw new Error('month_key must be YYYY-MM');
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
  const topLines = articles.slice(0, 30).map((article, index) => `${index + 1}. ${articleLink(article)}：${(article.ocr_text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
  const summary = [
    `## ${monthKey} 月別まとめ（抽出型・暫定）`,
    `対象記事${articles.length}件。${reason}`,
    '',
    '## 代表記事候補',
    topLines.join('\n') || '代表記事候補なし',
    '',
    '## 限界',
    'この月別まとめは抽出型フォールバックです。全記事IDは保持していますが、意味統合・反証・WHY分析の品質は通常の月別rollupより低いです。'
  ].join('\n');
  return {
    summary,
    summaryJson: {
      summary_text: summary,
      major_themes: ['抽出型フォールバックのため、主要テーマは未統合'],
      consumer_narrative: '全記事ID・代表記事候補のみ保持。',
      weak_signals: [],
      evidence_matrix: topLines,
      refutation_notes: [reason],
      research_needs: ['通常rollupを再生成し、抽出型フォールバックの読みを検証する'],
      representative_article_ids: representative,
      evidence_article_ids: evidence,
      generation_warning: 'extractive_fallback_rollup'
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
  const articleIds = articles.map((article) => article.id);
  const latestDate = articles.map((article) => article.article_date || article.created_at || '').filter(Boolean).sort().at(-1) || null;

  if (!articles.length) {
    return upsertMonthlyRollup(monthKey, 0, [], null, 'extractive_fallback', `${monthKey}の対象記事はありません。`, { month_key: monthKey, article_count: 0 }, [], [], 'ready', null);
  }

  const fallback = buildFallbackRollup(monthKey, articles, '本番build復旧を優先し、月別rollupは抽出型fallbackとして保存します。');
  return upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, 'extractive_fallback', fallback.summary, fallback.summaryJson, fallback.representative, fallback.evidence, 'ready', null);
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

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI } from '@/lib/openai';

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

function monthKeyFromDate(value: unknown) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : '';
}

function articleLink(article: RollupArticle) {
  return `[${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}](/articles/${article.id})`;
}

function textLimit(count: number) {
  if (count > 120) return 450;
  if (count > 80) return 600;
  if (count > 40) return 850;
  return 1200;
}

function rollupModel() {
  return (process.env.OPENAI_ROLLUP_MODEL || 'gpt-5-nano').trim();
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
  const { start, end } = monthRange(monthKey);
  const { data, error } = await supabaseAdmin
    .from('articles')
    .select(SELECT)
    .gte('article_date', start)
    .lt('article_date', end)
    .order('article_date', { ascending: true });
  if (error) throw error;
  return ((data || []) as RollupArticle[]).filter(active);
}

export async function listArticleMonths() {
  const { data, error } = await supabaseAdmin
    .from('articles')
    .select('article_date,status')
    .not('article_date', 'is', null)
    .order('article_date', { ascending: false });
  if (error) throw error;
  const months = new Set<string>();
  for (const row of data || []) {
    if (row.status && HIDDEN.has(row.status)) continue;
    const monthKey = monthKeyFromDate(row.article_date);
    if (monthKey) months.add(monthKey);
  }
  return Array.from(months).sort().reverse();
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

export async function generateStaleMonthlyRollups() {
  const months = await listStaleRollupMonths();
  const results = [];
  for (const month of months) {
    results.push(await generateMonthlyRollup(month));
  }
  return results;
}

export async function generateMonthlyRollup(monthKey: string) {
  const articles = await getArticlesForMonth(monthKey);
  const model = rollupModel();
  const openai = getOpenAI();
  const articleIds = articles.map((article) => article.id);
  const latestDate = articles.map((article) => article.article_date || article.created_at || '').filter(Boolean).sort().at(-1) || null;

  if (!openai) {
    const summary = `OPENAI_API_KEY未設定のため、${monthKey}の月別まとめは生成できません。対象記事数: ${articles.length}`;
    return upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, model, summary, { error: 'OPENAI_API_KEY missing' }, [], [], 'failed', 'OPENAI_API_KEY missing');
  }

  if (!articles.length) {
    return upsertMonthlyRollup(monthKey, 0, [], null, model, `${monthKey}の対象記事はありません。`, { month_key: monthKey, article_count: 0 }, [], [], 'ready', null);
  }

  await upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, model, '', {}, [], [], 'running', null);

  const limit = textLimit(articles.length);
  const articlePayload = articles.map((article, index) => ({
    no: index + 1,
    article_id: article.id,
    article_link: articleLink(article),
    headline: article.headline,
    article_date: article.article_date || '日付不明',
    text: (article.ocr_text || '').slice(0, limit)
  }));

  const system = [
    'Return JSON only.',
    'You create a monthly intelligence rollup for accumulated Nikkei MJ articles.',
    'Do not write generic summaries. Preserve weak signals, contradictions, and research opportunities.',
    'Required keys: summary_text, major_themes, consumer_narrative, weak_signals, evidence_matrix, refutation_notes, research_needs, representative_article_ids, evidence_article_ids, next_month_watchpoints.',
    'Use article_link when citing evidence. Mark weak interpretations as hypotheses.'
  ].join('\n');

  try {
    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ month_key: monthKey, article_count: articles.length, articles: articlePayload }, null, 2) }
      ]
    });
    const raw = completion.choices[0]?.message.content || '{}';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = typeof parsed.summary_text === 'string' ? parsed.summary_text : raw;
    const representative = Array.isArray(parsed.representative_article_ids) ? parsed.representative_article_ids.map(String).filter(Boolean) : [];
    const evidence = Array.isArray(parsed.evidence_article_ids) ? parsed.evidence_article_ids.map(String).filter(Boolean) : representative;
    return upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, model, summary, parsed, representative, evidence, 'ready', null);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'monthly rollup failed';
    return upsertMonthlyRollup(monthKey, articles.length, articleIds, latestDate, model, `月別まとめ生成に失敗しました: ${message}`, { error: message }, [], [], 'failed', message);
  }
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

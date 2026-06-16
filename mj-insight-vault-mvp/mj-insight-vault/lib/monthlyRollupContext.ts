import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listArticleMonthCounts, listArticleMonths } from '@/lib/monthlyRollups';

type MonthlyRollup = {
  month_key: string;
  article_count: number;
  summary_text: string;
  summary_json: Record<string, unknown> | null;
  representative_article_ids: string[] | null;
  evidence_article_ids: string[] | null;
  status: string;
  generated_at: string | null;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function extractBullets(json: Record<string, unknown> | null, key: string, max = 5) {
  if (!json) return [];
  const value = json[key];
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return text(record.theme || record.title || record.claim || record.hypothesis || record.summary || record.note || JSON.stringify(record));
    }
    return text(item);
  }).filter(Boolean);
}

export async function buildMonthlyRollupContext() {
  const [{ data, error }, articleMonths, articleMonthCounts] = await Promise.all([
    supabaseAdmin
      .from('monthly_rollups')
      .select('month_key, article_count, summary_text, summary_json, representative_article_ids, evidence_article_ids, status, generated_at')
      .order('month_key', { ascending: true }),
    listArticleMonths(),
    listArticleMonthCounts()
  ]);

  if (error) throw error;
  const rows = (data || []) as MonthlyRollup[];
  const readyRows = rows.filter((row) => row.status === 'ready');
  const byMonth = new Map(rows.map((row) => [row.month_key, row]));
  const readyMonths = readyRows.map((row) => row.month_key);
  const staleMonths = rows.filter((row) => row.status === 'stale').map((row) => row.month_key);
  const failedMonths = rows.filter((row) => row.status === 'failed').map((row) => row.month_key);
  const runningMonths = rows.filter((row) => row.status === 'running').map((row) => row.month_key);
  const missingMonths = articleMonths.filter((month) => !byMonth.has(month));
  const statusCounts = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.status || 'unknown'] = (counts[row.status || 'unknown'] || 0) + 1;
    return counts;
  }, {});
  const totalArticleCount = Object.values(articleMonthCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  const readyArticleCount = readyRows.reduce((sum, row) => sum + Number(row.article_count || 0), 0);
  const readyArticleCountMatches = totalArticleCount > 0 && readyArticleCount === totalArticleCount;
  const coverageComplete = articleMonths.length > 0
    && readyMonths.length === articleMonths.length
    && staleMonths.length === 0
    && failedMonths.length === 0
    && runningMonths.length === 0
    && missingMonths.length === 0
    && readyArticleCountMatches;

  const base = {
    status_counts: statusCounts,
    ready_months: readyMonths,
    stale_months: staleMonths,
    failed_months: failedMonths,
    running_months: runningMonths,
    missing_months: missingMonths,
    article_months: articleMonths,
    article_month_count: articleMonths.length,
    total_article_count: totalArticleCount,
    ready_article_count: readyArticleCount,
    ready_article_count_matches: readyArticleCountMatches,
    coverage_complete: coverageComplete
  };

  if (!readyRows.length) {
    return {
      has_rollups: false,
      rollup_count: 0,
      article_count: 0,
      context_text: '',
      representative_article_ids: [] as string[],
      evidence_article_ids: [] as string[],
      ...base
    };
  }

  const representative = new Set<string>();
  const evidence = new Set<string>();
  const sections = readyRows.map((row) => {
    for (const id of arrayText(row.representative_article_ids)) representative.add(id);
    for (const id of arrayText(row.evidence_article_ids)) evidence.add(id);
    const json = row.summary_json || {};
    const themes = extractBullets(json, 'major_themes');
    const weakSignals = extractBullets(json, 'weak_signals');
    const researchNeeds = extractBullets(json, 'research_needs');
    return [
      `## ${row.month_key}（${row.article_count}記事）`,
      row.summary_text ? row.summary_text.slice(0, 1800) : '',
      themes.length ? `主要テーマ:\n- ${themes.join('\n- ')}` : '',
      weakSignals.length ? `弱い兆し:\n- ${weakSignals.join('\n- ')}` : '',
      researchNeeds.length ? `調査論点:\n- ${researchNeeds.join('\n- ')}` : ''
    ].filter(Boolean).join('\n');
  });

  return {
    has_rollups: true,
    rollup_count: readyRows.length,
    article_count: readyArticleCount,
    context_text: sections.join('\n\n').slice(0, 30000),
    representative_article_ids: Array.from(representative).slice(0, 80),
    evidence_article_ids: Array.from(evidence).slice(0, 120),
    ...base
  };
}

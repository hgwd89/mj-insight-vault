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
  rollup_model: string;
  generated_at: string | null;
  lease_expires_at?: string | null;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function bool(value: unknown) {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes'].includes(text(value).toLowerCase());
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

function isExtractiveFallback(row: MonthlyRollup) {
  const json = row.summary_json || {};
  return row.rollup_model === 'extractive_fallback'
    || bool(json.fallback_used)
    || text(json.generation_warning) === 'extractive_fallback_rollup'
    || text(row.summary_text).toLowerCase().includes('extractive fallback');
}

function activeRunning(row: MonthlyRollup) {
  if (row.status !== 'running') return false;
  const expires = Date.parse(text(row.lease_expires_at));
  return Number.isFinite(expires) && expires > Date.now();
}

function validatedReady(row: MonthlyRollup, expectedCount: number) {
  if (row.status !== 'ready' || row.article_count !== expectedCount || isExtractiveFallback(row)) return false;
  const json = row.summary_json || {};
  const method = text(json.generation_method);
  const sourceIds = arrayText(json.source_article_ids);
  return bool(json.rollup_analysis_is_validated)
    && !bool(json.fallback_used)
    && ['hierarchical_llm_worker', 'hierarchical_llm', 'empty'].includes(method)
    && (expectedCount === 0 || sourceIds.length === expectedCount)
    && Boolean(text(json.source_fingerprint) || method === 'empty');
}

async function fetchRollupRows() {
  const modernSelect = 'month_key, article_count, summary_text, summary_json, representative_article_ids, evidence_article_ids, status, rollup_model, generated_at, lease_expires_at';
  const legacySelect = 'month_key, article_count, summary_text, summary_json, representative_article_ids, evidence_article_ids, status, rollup_model, generated_at';
  const modern = await supabaseAdmin.from('monthly_rollups').select(modernSelect).order('month_key', { ascending: true });
  if (!modern.error) return (modern.data || []) as unknown as MonthlyRollup[];
  if (modern.error.code !== '42703' && !text(modern.error.message).includes('lease_expires_at')) throw modern.error;

  const legacy = await supabaseAdmin.from('monthly_rollups').select(legacySelect).order('month_key', { ascending: true });
  if (legacy.error) throw legacy.error;
  return (legacy.data || []) as unknown as MonthlyRollup[];
}

export async function buildMonthlyRollupContext() {
  const [rows, articleMonths, articleMonthCounts] = await Promise.all([
    fetchRollupRows(),
    listArticleMonths(),
    listArticleMonthCounts()
  ]);

  const byMonth = new Map(rows.map((row) => [row.month_key, row]));
  const readyRows = rows.filter((row) => validatedReady(row, Number(articleMonthCounts[row.month_key] || 0)));
  const readySet = new Set(readyRows.map((row) => row.month_key));
  const fallbackMonths = rows.filter(isExtractiveFallback).map((row) => row.month_key);
  const staleMonths = rows.filter((row) => row.status === 'stale').map((row) => row.month_key);
  const failedMonths = rows.filter((row) => row.status === 'failed').map((row) => row.month_key);
  const pendingMonths = rows.filter((row) => row.status === 'queued' || activeRunning(row)).map((row) => row.month_key);
  const expiredRunningMonths = rows.filter((row) => row.status === 'running' && !activeRunning(row)).map((row) => row.month_key);
  const missingMonths = articleMonths.filter((month) => !byMonth.has(month));
  const invalidReadyMonths = rows
    .filter((row) => row.status === 'ready' && !readySet.has(row.month_key))
    .map((row) => row.month_key);
  const unreadyMonths = articleMonths.filter((month) => !readySet.has(month));
  const statusCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const key = row.status || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const totalArticleCount = Object.values(articleMonthCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  const readyArticleCount = readyRows.reduce((sum, row) => sum + Number(row.article_count || 0), 0);
  const readyArticleCountMatches = totalArticleCount > 0 && readyArticleCount === totalArticleCount;
  const coverageComplete = articleMonths.length > 0
    && unreadyMonths.length === 0
    && readyArticleCountMatches;

  const base = {
    status_counts: statusCounts,
    ready_months: readyRows.map((row) => row.month_key),
    stale_months: staleMonths,
    failed_months: failedMonths,
    running_months: pendingMonths,
    pending_months: pendingMonths,
    expired_running_months: expiredRunningMonths,
    missing_months: missingMonths,
    invalid_ready_months: invalidReadyMonths,
    unready_months: unreadyMonths,
    fallback_months: fallbackMonths,
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
      `## ${row.month_key}（${row.article_count}記事・検証済み）`,
      row.summary_text ? row.summary_text.slice(0, 1200) : '',
      themes.length ? `主要テーマ:\n- ${themes.join('\n- ')}` : '',
      weakSignals.length ? `弱い兆し:\n- ${weakSignals.join('\n- ')}` : '',
      researchNeeds.length ? `調査論点:\n- ${researchNeeds.join('\n- ')}` : ''
    ].filter(Boolean).join('\n');
  });

  return {
    has_rollups: true,
    rollup_count: readyRows.length,
    article_count: readyArticleCount,
    context_text: sections.join('\n\n').slice(0, 18000),
    representative_article_ids: Array.from(representative).slice(0, 80),
    evidence_article_ids: Array.from(evidence).slice(0, 120),
    ...base
  };
}

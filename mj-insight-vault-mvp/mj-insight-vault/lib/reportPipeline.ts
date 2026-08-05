import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createFullCorpusScanRun, runFullCorpusScanBatches } from '@/lib/fullCorpusScan';

type JsonRecord = Record<string, unknown>;

export type ReportScope = {
  scopeType: 'all' | 'category';
  scopeQuery: string;
  categoryName?: string;
};

export type BoundedCorpusContext = {
  run?: JsonRecord | null;
  context_text?: string;
  full_corpus_gate?: string;
  gate_reason?: string;
  current_article_count?: number;
  current_article_count_diff?: number;
  completed_batches?: number;
  batches?: JsonRecord[];
};

export type ReportPreparation = {
  required: boolean;
  ready: boolean;
  terminal: boolean;
  scope: ReportScope;
  context: BoundedCorpusContext;
  progress: number;
  stage: string;
  error?: string;
  created_new_run?: boolean;
};

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
const MAX_CONTEXT_CHARS = 90_000;
const DETAIL_KEYS = [
  'article_id',
  'evidence_article_ids',
  'headline',
  'article_date',
  'observed_fact',
  'what_can_be_said',
  'what_cannot_be_said',
  'narrative',
  'consumer_narrative',
  'signal',
  'behavior_signal',
  'theme',
  'question',
  'research_question',
  'hypothesis',
  'why_it_matters',
  'constraint',
  'contradiction',
  'weak_signal',
  'limitation'
];

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function num(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requestedCategory(body: JsonRecord) {
  return text(body.category_id || body.analysis_category_id || body.category);
}

async function inferCategoryFromQuery(query: string) {
  const { data, error } = await supabaseAdmin
    .from('analysis_categories')
    .select('id, name_ja, keywords')
    .eq('is_active', true);
  if (error) return null;

  const lowerQuery = query.toLowerCase();
  for (const row of data || []) {
    const id = text(row.id);
    const name = text(row.name_ja);
    const keywords = Array.isArray(row.keywords) ? row.keywords.map(text) : [];
    if (
      lowerQuery.includes(id.toLowerCase())
      || (name && query.includes(name))
      || keywords.some((keyword) => keyword && lowerQuery.includes(keyword.toLowerCase()))
    ) {
      return { id, name };
    }
  }
  return null;
}

export async function resolveReportScope(body: JsonRecord): Promise<ReportScope> {
  const explicit = requestedCategory(body);
  if (explicit) return { scopeType: 'category', scopeQuery: explicit };

  const query = text(body.query);
  const target = text(body.target_scope);
  const inferred = await inferCategoryFromQuery(query);
  if (target === 'category' && inferred?.id) {
    return { scopeType: 'category', scopeQuery: inferred.id, categoryName: inferred.name };
  }
  if (inferred?.id && !ALL_WORDS.test(query)) {
    return { scopeType: 'category', scopeQuery: inferred.id, categoryName: inferred.name };
  }
  return { scopeType: 'all', scopeQuery: '' };
}

export function requiresFullCorpus(body: JsonRecord, scope: ReportScope) {
  if (body.require_full_corpus === false) return false;
  if (scope.scopeType === 'category') return true;
  return text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query));
}

function compactUnknown(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, 280);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 2) return text(value).slice(0, 180);
  if (Array.isArray(value)) return value.slice(0, 6).map((item) => compactUnknown(item, depth + 1));
  if (!isRecord(value)) return text(value).slice(0, 180);

  const selected = new Set<string>();
  const output: JsonRecord = {};
  for (const key of DETAIL_KEYS) {
    if (value[key] === undefined) continue;
    output[key] = compactUnknown(value[key], depth + 1);
    selected.add(key);
  }
  for (const [key, item] of Object.entries(value)) {
    if (selected.has(key) || Object.keys(output).length >= 10) continue;
    output[key] = compactUnknown(item, depth + 1);
  }
  return output;
}

function compactList(summary: JsonRecord, key: string, limit: number) {
  const value = summary[key];
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => compactUnknown(item));
}

function detailedDigest(batch: JsonRecord) {
  const summary = isRecord(batch.summary_json) ? batch.summary_json : {};
  return {
    batch_index: num(batch.batch_index),
    article_count: num(batch.article_count),
    consumer_narratives: compactList(summary, 'consumer_narratives', 1),
    behavior_signals: compactList(summary, 'behavior_signals', 1),
    constraints: compactList(summary, 'constraints', 1),
    contradictions: compactList(summary, 'contradictions', 1),
    weak_signals: compactList(summary, 'weak_signals', 1),
    research_needs: compactList(summary, 'research_needs', 1),
    evidence: compactList(summary, 'evidence', 2)
  };
}

function buildBoundedDigests(batches: JsonRecord[]) {
  const digests: JsonRecord[] = [];
  let usedChars = 0;
  let detailedBatches = 0;

  for (const batch of batches) {
    const detailed = detailedDigest(batch);
    const detailedChars = JSON.stringify(detailed).length;
    if (usedChars + detailedChars <= MAX_CONTEXT_CHARS) {
      digests.push(detailed);
      usedChars += detailedChars;
      detailedBatches += 1;
    } else {
      const minimal = {
        batch_index: num(batch.batch_index),
        article_count: num(batch.article_count),
        detail_omitted_for_prompt_budget: true
      };
      digests.push(minimal);
      usedChars += JSON.stringify(minimal).length;
    }
  }

  return { digests, usedChars, detailedBatches };
}

async function latestRun(scope: ReportScope) {
  let query = supabaseAdmin
    .from('full_corpus_scan_runs')
    .select('*')
    .eq('scope_type', scope.scopeType)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (scope.scopeType === 'category') {
    query = supabaseAdmin
      .from('full_corpus_scan_runs')
      .select('*')
      .eq('scope_type', 'category')
      .eq('scope_query', scope.scopeQuery)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
  }

  const { data, error } = await query;
  if (error) throw error;
  return isRecord(data) ? data : null;
}

export async function getBoundedFullCorpusContext(
  scopeType: 'all' | 'category' = 'all',
  scopeQuery = ''
): Promise<BoundedCorpusContext> {
  const scope: ReportScope = { scopeType, scopeQuery };
  const run = await latestRun(scope);
  if (!run) {
    return {
      run: null,
      context_text: '',
      full_corpus_gate: 'failed',
      gate_reason: 'no_full_corpus_scan_run',
      current_article_count: 0,
      current_article_count_diff: 0,
      completed_batches: 0,
      batches: []
    };
  }

  const { data: gateData, error: gateError } = await supabaseAdmin
    .from('corpus_scan_gate_view')
    .select('full_corpus_gate, gate_reason, current_article_count, current_article_count_diff')
    .eq('id', text(run.id))
    .maybeSingle();
  if (gateError) throw gateError;

  const { data: batches, error: batchError } = await supabaseAdmin
    .from('full_corpus_scan_batches')
    .select('batch_index, article_count, status, summary_json')
    .eq('run_id', text(run.id))
    .eq('status', 'completed')
    .order('batch_index', { ascending: true });
  if (batchError) throw batchError;

  const completed = (batches || []).filter(isRecord);
  const bounded = buildBoundedDigests(completed);
  const gate = text(gateData?.full_corpus_gate) || 'failed';
  const gateReason = text(gateData?.gate_reason) || 'unknown';
  const currentArticleCount = num(gateData?.current_article_count || run.active_article_count);
  const currentArticleCountDiff = num(gateData?.current_article_count_diff);

  const contextPayload = {
    full_corpus_gate: gate,
    gate_reason: gateReason,
    run_id: text(run.id),
    scope_type: text(run.scope_type),
    scope_query: text(run.scope_query),
    active_article_count: num(run.active_article_count),
    current_article_count: currentArticleCount,
    current_article_count_diff: currentArticleCountDiff,
    ocr_ready_article_count: num(run.ocr_ready_article_count),
    analyzed_article_count: num(run.analyzed_article_count),
    total_batches: num(run.total_batches),
    completed_batches: num(run.completed_batches),
    failed_batches: num(run.failed_batches),
    needs_review_batches: num(run.needs_review_batches),
    prompt_budget: {
      max_detail_chars: MAX_CONTEXT_CHARS,
      used_detail_chars: bounded.usedChars,
      detailed_batches: bounded.detailedBatches,
      total_completed_batches: completed.length
    },
    batch_digests: bounded.digests
  };

  return {
    run,
    batches: completed,
    completed_batches: completed.length,
    full_corpus_gate: gate,
    gate_reason: gateReason,
    current_article_count: currentArticleCount,
    current_article_count_diff: currentArticleCountDiff,
    context_text: JSON.stringify(contextPayload)
  };
}

function scanProgress(context: BoundedCorpusContext) {
  const run = isRecord(context.run) ? context.run : {};
  const total = Math.max(1, num(run.total_batches));
  const completed = num(run.completed_batches);
  return Math.max(8, Math.min(62, 8 + Math.floor((completed / total) * 54)));
}

function scanStage(context: BoundedCorpusContext, scope: ReportScope, rebuilt = false) {
  const run = isRecord(context.run) ? context.run : {};
  const completed = num(run.completed_batches);
  const total = num(run.total_batches);
  const label = scope.scopeType === 'category'
    ? `カテゴリ「${scope.categoryName || scope.scopeQuery}」`
    : '全件';
  const prefix = rebuilt ? '最新記事でscanを再構築。' : '';
  return `${prefix}${label}本文読解 ${completed}/${total}バッチ`;
}

function passed(context: BoundedCorpusContext) {
  const run = isRecord(context.run) ? context.run : null;
  if (!run) return false;
  return context.full_corpus_gate === 'passed'
    && text(run.status) === 'completed'
    && num(run.total_batches) > 0
    && num(run.completed_batches) === num(run.total_batches)
    && num(run.failed_batches) === 0
    && num(run.needs_review_batches) === 0
    && num(run.analyzed_article_count) === num(run.ocr_ready_article_count);
}

function terminalProblem(context: BoundedCorpusContext) {
  const run = isRecord(context.run) ? context.run : {};
  if (num(run.failed_batches) > 0) {
    return `本文読解バッチに失敗があります。run_id=${text(run.id)} failed_batches=${num(run.failed_batches)}`;
  }
  if (num(run.needs_review_batches) > 0) {
    return `本文読解結果が検証条件を満たしていません。run_id=${text(run.id)} needs_review_batches=${num(run.needs_review_batches)}`;
  }
  if (num(run.total_batches) === 0) {
    return `本文読解対象がありません。run_id=${text(run.id) || 'none'}`;
  }
  return '';
}

export async function prepareReportCorpus(
  body: JsonRecord,
  maxBatches = 1
): Promise<ReportPreparation> {
  const scope = await resolveReportScope(body);
  const required = requiresFullCorpus(body, scope);
  if (!required) {
    return {
      required: false,
      ready: true,
      terminal: false,
      scope,
      context: {},
      progress: 64,
      stage: '本文読解ゲート対象外'
    };
  }

  let context = await getBoundedFullCorpusContext(scope.scopeType, scope.scopeQuery);
  if (passed(context)) {
    return {
      required: true,
      ready: true,
      terminal: false,
      scope,
      context,
      progress: 64,
      stage: '本文読解完了。レポート生成へ移行'
    };
  }

  let createdNewRun = false;
  const stale = context.gate_reason === 'run_stale_article_count_mismatch';
  if (!context.run || stale) {
    const batchSize = Math.max(10, Math.min(40, Math.round(Number(process.env.OPENAI_SCAN_BATCH_SIZE || 30))));
    await createFullCorpusScanRun({
      scope_type: scope.scopeType,
      scope_query: scope.scopeQuery,
      model: process.env.OPENAI_SCAN_MODEL || 'gpt-4o-mini',
      batch_size: batchSize
    });
    createdNewRun = true;
    context = await getBoundedFullCorpusContext(scope.scopeType, scope.scopeQuery);
  }

  const beforeProblem = terminalProblem(context);
  if (beforeProblem) {
    return {
      required: true,
      ready: false,
      terminal: true,
      scope,
      context,
      progress: 100,
      stage: '本文読解の検証に失敗',
      error: beforeProblem,
      created_new_run: createdNewRun
    };
  }

  const run = isRecord(context.run) ? context.run : {};
  try {
    await runFullCorpusScanBatches(text(run.id), Math.max(1, Math.min(3, Math.round(maxBatches))));
  } catch (error) {
    const message = error instanceof Error ? error.message : '本文読解バッチの実行に失敗しました';
    if (message.includes('run is stale; rebuild required')) {
      await createFullCorpusScanRun({
        scope_type: scope.scopeType,
        scope_query: scope.scopeQuery,
        model: process.env.OPENAI_SCAN_MODEL || 'gpt-4o-mini',
        batch_size: Math.max(10, Math.min(40, Math.round(Number(process.env.OPENAI_SCAN_BATCH_SIZE || 30))))
      });
      context = await getBoundedFullCorpusContext(scope.scopeType, scope.scopeQuery);
      return {
        required: true,
        ready: false,
        terminal: false,
        scope,
        context,
        progress: scanProgress(context),
        stage: scanStage(context, scope, true),
        created_new_run: true
      };
    }
    return {
      required: true,
      ready: false,
      terminal: true,
      scope,
      context,
      progress: 100,
      stage: '本文読解バッチ実行エラー',
      error: message,
      created_new_run: createdNewRun
    };
  }

  context = await getBoundedFullCorpusContext(scope.scopeType, scope.scopeQuery);
  const afterProblem = terminalProblem(context);
  if (afterProblem) {
    return {
      required: true,
      ready: false,
      terminal: true,
      scope,
      context,
      progress: 100,
      stage: '本文読解の検証に失敗',
      error: afterProblem,
      created_new_run: createdNewRun
    };
  }

  return {
    required: true,
    ready: passed(context),
    terminal: false,
    scope,
    context,
    progress: passed(context) ? 64 : scanProgress(context),
    stage: passed(context)
      ? '本文読解完了。レポート生成へ移行'
      : scanStage(context, scope, createdNewRun),
    created_new_run: createdNewRun
  };
}

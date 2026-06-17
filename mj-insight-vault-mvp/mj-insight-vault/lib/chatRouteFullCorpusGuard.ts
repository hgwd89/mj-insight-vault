import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchAllWideArticles } from '@/lib/wideArticleRetrieval';
import { getFullCorpusContext } from '@/lib/fullCorpusScan';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type JsonRecord = Record<string, unknown>;
type CorpusContext = { run?: JsonRecord | null; context_text?: string; full_corpus_gate?: string };
type Scope = { scopeType: 'all' | 'category'; scopeQuery: string; categoryName?: string };

function text(value: unknown) { return value === undefined || value === null ? '' : String(value).trim(); }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function num(run: JsonRecord, key: string) { return Number(run[key] || 0); }
function requestedCategory(body: JsonRecord) { return text(body.category_id || body.analysis_category_id || body.category); }

async function inferCategoryFromQuery(query: string) {
  const { data, error } = await supabaseAdmin.from('analysis_categories').select('id, name_ja, keywords').eq('is_active', true);
  if (error) return null;
  const q = query.toLowerCase();
  for (const row of data || []) {
    const id = text(row.id);
    const name = text(row.name_ja);
    const keywords = Array.isArray(row.keywords) ? row.keywords.map(text) : [];
    if (q.includes(id.toLowerCase()) || (name && query.includes(name)) || keywords.some((kw) => kw && q.includes(kw.toLowerCase()))) return { id, name };
  }
  return null;
}

async function resolveScope(body: JsonRecord): Promise<Scope> {
  const explicit = requestedCategory(body);
  if (explicit) return { scopeType: 'category', scopeQuery: explicit };
  const target = text(body.target_scope);
  if (target === 'category') {
    const inferred = await inferCategoryFromQuery(text(body.query));
    if (inferred?.id) return { scopeType: 'category', scopeQuery: inferred.id, categoryName: inferred.name };
  }
  const inferred = await inferCategoryFromQuery(text(body.query));
  if (inferred?.id && !ALL_WORDS.test(text(body.query))) return { scopeType: 'category', scopeQuery: inferred.id, categoryName: inferred.name };
  return { scopeType: 'all', scopeQuery: '' };
}

function shouldGuard(body: JsonRecord, scope: Scope) {
  if (body.require_full_corpus === false) return false;
  if (scope.scopeType === 'category') return true;
  return text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query));
}

function passed(context: CorpusContext) {
  const run = isRecord(context.run) ? context.run : null;
  if (!run) return false;
  return context.full_corpus_gate === 'passed'
    && text(run.status) === 'completed'
    && num(run, 'total_batches') > 0
    && num(run, 'completed_batches') === num(run, 'total_batches')
    && num(run, 'failed_batches') === 0
    && num(run, 'needs_review_batches') === 0
    && num(run, 'analyzed_article_count') > 0
    && num(run, 'analyzed_article_count') === num(run, 'ocr_ready_article_count');
}

function corpusMessage(context: CorpusContext, scope: Scope) {
  const contextText = text(context.context_text);
  if (!contextText) return [];
  if (scope.scopeType === 'category') {
    return [{ role: 'user', content: [
      `【CATEGORY_FULL_CORPUS_BATCH_ANALYSIS_PRIMARY:${scope.scopeQuery}】`,
      'このカテゴリ本文読解結果を一次入力にしてください。代表記事検索や月別rollupより優先してください。',
      'カテゴリ外の記事は、比較・反証目的以外では主要根拠に使わないでください。',
      contextText
    ].join('\n') }];
  }
  return [{ role: 'user', content: ['【FULL_CORPUS_BATCH_ANALYSIS_PRIMARY】', contextText].join('\n') }];
}

function categoryQuery(query: string, scope: Scope) {
  if (scope.scopeType !== 'category') return query;
  return [query, `対象カテゴリID: ${scope.scopeQuery}`, scope.categoryName ? `対象カテゴリ名: ${scope.categoryName}` : '', 'このカテゴリの生活者ナラティブとインサイトに限定して分析してください。'].filter(Boolean).join('\n');
}

async function diagnostic(query: string, body: JsonRecord, context: CorpusContext, scope: Scope) {
  const allArticles = await fetchAllWideArticles();
  const run = isRecord(context.run) ? context.run : {};
  const scopeLabel = scope.scopeType === 'category' ? `カテゴリ「${scope.categoryName || scope.scopeQuery}」` : '全件';
  const answer = {
    report_title: `${scopeLabel}本文読解未完了`,
    target_scope: scope.scopeType,
    category_id: scope.scopeType === 'category' ? scope.scopeQuery : '',
    model_used: text(body.model || ''),
    full_corpus_gate: 'failed',
    analysis_is_provisional: true,
    related_article_count: allArticles.length,
    article_count_scanned: allArticles.length,
    source_coverage: {
      active_article_count: allArticles.length,
      scanned_article_count: allArticles.length,
      scope_type: scope.scopeType,
      scope_query: scope.scopeQuery,
      full_corpus_gate: 'failed',
      full_corpus_run_id: text(run.id),
      full_corpus_analyzed_article_count: num(run, 'analyzed_article_count'),
      full_corpus_ocr_ready_article_count: num(run, 'ocr_ready_article_count'),
      full_corpus_total_batches: num(run, 'total_batches'),
      full_corpus_completed_batches: num(run, 'completed_batches'),
      full_corpus_failed_batches: num(run, 'failed_batches'),
      full_corpus_needs_review_batches: num(run, 'needs_review_batches')
    },
    quality_gate: { status: 'failed', failed_checks: ['full_corpus_gate'] },
    answer_text: [
      '## 1. 結論',
      `${scopeLabel}の本文読解が未完了のため、正式分析レポートは生成していません。`,
      '',
      '## 2. 状態',
      `- 指示: ${query}`,
      `- scope: ${scope.scopeType}`,
      `- category_id: ${scope.scopeQuery || '-'}`,
      `- scan_run_id: ${text(run.id) || '未作成'}`,
      `- OCR済み記事数: ${num(run, 'ocr_ready_article_count') || '未確認'}`,
      `- 本文読解済み記事数: ${num(run, 'analyzed_article_count')}`,
      `- 完了バッチ: ${num(run, 'completed_batches')} / ${num(run, 'total_batches')}`,
      `- 失敗バッチ: ${num(run, 'failed_batches')}`,
      `- 要レビューBatch: ${num(run, 'needs_review_batches')}`,
      '',
      '## 3. 必要な対応',
      scope.scopeType === 'category' ? `カテゴリ ${scope.scopeQuery} のrunを /api/corpus-scans/progress で完了させてください。` : '/api/corpus-scans/progress で全体runを完了させてください。'
    ].join('\n')
  };
  let report = null;
  let report_error = '';
  try {
    const saved = await supabaseAdmin.from('chat_reports').insert({ user_query: query, answer_text: answer.answer_text, answer_json: answer, related_article_ids: allArticles.map((article) => article.id) }).select('*').single();
    if (saved.error) throw saved.error;
    report = saved.data;
  } catch (error) {
    report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
  }
  return { report, report_error, related_articles: allArticles, selectable_models: [], answer };
}

export async function runChatAnalysis(body: JsonRecord, onProgress?: ProgressReporter) {
  const query = text(body.query);
  const scope = await resolveScope(body);
  if (!shouldGuard(body, scope)) return runBaseChatAnalysis(body, onProgress);
  await onProgress?.({ progress: 12, stage: scope.scopeType === 'category' ? 'カテゴリ本文読解ゲートを確認中' : '全件本文読解ゲートを確認中' });
  const context = await getFullCorpusContext(scope.scopeType, scope.scopeQuery) as CorpusContext;
  if (!passed(context)) {
    const result = await diagnostic(query, body, context, scope);
    await onProgress?.({ progress: 100, stage: '本文読解未完了' });
    return result;
  }
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];
  const routedBody = {
    ...body,
    query: categoryQuery(query, scope),
    target_scope: 'all',
    category_id: scope.scopeQuery,
    analysis_scope_type: scope.scopeType,
    conversation: [...conversation, ...corpusMessage(context, scope)],
    full_corpus_gate: 'passed'
  };
  const result = await runBaseChatAnalysis(routedBody, onProgress) as JsonRecord;
  if (isRecord(result.answer)) {
    const run = isRecord(context.run) ? context.run : {};
    result.answer.full_corpus_gate = 'passed';
    result.answer.target_scope = scope.scopeType;
    result.answer.category_id = scope.scopeQuery;
    result.answer.full_corpus_run_id = text(run.id);
    result.answer.source_coverage = { ...(isRecord(result.answer.source_coverage) ? result.answer.source_coverage : {}), scope_type: scope.scopeType, scope_query: scope.scopeQuery, full_corpus_gate: 'passed', full_corpus_run_id: text(run.id), full_corpus_analyzed_article_count: num(run, 'analyzed_article_count'), full_corpus_ocr_ready_article_count: num(run, 'ocr_ready_article_count') };
  }
  return result;
}

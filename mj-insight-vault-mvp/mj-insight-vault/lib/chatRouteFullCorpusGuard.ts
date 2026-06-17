import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchAllWideArticles } from '@/lib/wideArticleRetrieval';
import { getFullCorpusContext } from '@/lib/fullCorpusScan';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type JsonRecord = Record<string, unknown>;
type CorpusContext = { run?: JsonRecord | null; context_text?: string; full_corpus_gate?: string };

function text(value: unknown) { return value === undefined || value === null ? '' : String(value).trim(); }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function wantsAll(body: JsonRecord) { return text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query)); }
function num(run: JsonRecord, key: string) { return Number(run[key] || 0); }

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

function corpusMessage(context: CorpusContext) {
  const contextText = text(context.context_text);
  if (!contextText) return [];
  return [{ role: 'user', content: ['【FULL_CORPUS_BATCH_ANALYSIS_PRIMARY】', contextText].join('\n') }];
}

async function diagnostic(query: string, body: JsonRecord, context: CorpusContext) {
  const articles = await fetchAllWideArticles();
  const run = isRecord(context.run) ? context.run : {};
  const answer = {
    report_title: '全件本文読解未完了',
    target_scope: text(body.target_scope || 'all'),
    model_used: text(body.model || ''),
    full_corpus_gate: 'failed',
    analysis_is_provisional: true,
    related_article_count: articles.length,
    article_count_scanned: articles.length,
    source_coverage: {
      active_article_count: articles.length,
      scanned_article_count: articles.length,
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
      '全件本文読解が未完了のため、全件分析レポートは生成していません。',
      '',
      '## 2. 状態',
      `- 指示: ${query}`,
      `- 有効記事数: ${articles.length}件`,
      `- scan_run_id: ${text(run.id) || '未作成'}`,
      `- OCR済み記事数: ${num(run, 'ocr_ready_article_count') || '未確認'}`,
      `- 本文読解済み記事数: ${num(run, 'analyzed_article_count')}`,
      `- 完了バッチ: ${num(run, 'completed_batches')} / ${num(run, 'total_batches')}`,
      `- 失敗バッチ: ${num(run, 'failed_batches')}`,
      `- 要レビューBatch: ${num(run, 'needs_review_batches')}`,
      '',
      '## 3. 必要な対応',
      '/corpus-scans でrunを作成し、全バッチをcompletedにしてください。'
    ].join('\n')
  };
  let report = null;
  let report_error = '';
  try {
    const saved = await supabaseAdmin.from('chat_reports').insert({ user_query: query, answer_text: answer.answer_text, answer_json: answer, related_article_ids: articles.map((article) => article.id) }).select('*').single();
    if (saved.error) throw saved.error;
    report = saved.data;
  } catch (error) {
    report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
  }
  return { report, report_error, related_articles: articles, selectable_models: [], answer };
}

export async function runChatAnalysis(body: JsonRecord, onProgress?: ProgressReporter) {
  const query = text(body.query);
  if (!wantsAll(body) || body.require_full_corpus === false) return runBaseChatAnalysis(body, onProgress);
  await onProgress?.({ progress: 12, stage: '全件本文読解ゲートを確認中' });
  const context = await getFullCorpusContext('all', '') as CorpusContext;
  if (!passed(context)) {
    const result = await diagnostic(query, body, context);
    await onProgress?.({ progress: 100, stage: '全件本文読解未完了' });
    return result;
  }
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];
  const result = await runBaseChatAnalysis({ ...body, conversation: [...conversation, ...corpusMessage(context)], full_corpus_gate: 'passed' }, onProgress) as JsonRecord;
  if (isRecord(result.answer)) {
    const run = isRecord(context.run) ? context.run : {};
    result.answer.full_corpus_gate = 'passed';
    result.answer.full_corpus_run_id = text(run.id);
    result.answer.source_coverage = { ...(isRecord(result.answer.source_coverage) ? result.answer.source_coverage : {}), full_corpus_gate: 'passed', full_corpus_run_id: text(run.id), full_corpus_analyzed_article_count: num(run, 'analyzed_article_count'), full_corpus_ocr_ready_article_count: num(run, 'ocr_ready_article_count') };
  }
  return result;
}

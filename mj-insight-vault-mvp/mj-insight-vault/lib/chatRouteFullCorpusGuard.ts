import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchAllWideArticles } from '@/lib/wideArticleRetrieval';
import { getFullCorpusContext } from '@/lib/fullCorpusScan';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type JsonRecord = Record<string, unknown>;

function text(value: unknown) { return value === undefined || value === null ? '' : String(value).trim(); }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function wantsAll(body: Record<string, unknown>) { return text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query)); }

function passed(context: Awaited<ReturnType<typeof getFullCorpusContext>>) {
  const run = isRecord(context.run) ? context.run : null;
  if (!run) return false;
  const total = Number(run.total_batches || 0);
  const completed = Number(run.completed_batches || 0);
  const failed = Number(run.failed_batches || 0);
  const needsReview = Number(run.needs_review_batches || 0);
  const analyzed = Number(run.analyzed_article_count || 0);
  const ocrReady = Number(run.ocr_ready_article_count || 0);
  return context.full_corpus_gate === 'passed' && run.status === 'completed' && total > 0 && completed === total && failed === 0 && needsReview === 0 && analyzed > 0 && analyzed === ocrReady;
}

function corpusMessage(context: Awaited<ReturnType<typeof getFullCorpusContext>>) {
  if (!context.context_text) return [];
  return [{ role: 'user', content: ['【FULL_CORPUS_BATCH_ANALYSIS_PRIMARY】', context.context_text].join('\n') }];
}

async function diagnostic(query: string, body: Record<string, unknown>, context: Awaited<ReturnType<typeof getFullCorpusContext>>) {
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
      full_corpus_analyzed_article_count: Number(run.analyzed_article_count || 0),
      full_corpus_ocr_ready_article_count: Number(run.ocr_ready_article_count || 0),
      full_corpus_total_batches: Number(run.total_batches || 0),
      full_corpus_completed_batches: Number(run.completed_batches || 0),
      full_corpus_failed_batches: Number(run.failed_batches || 0),
      full_corpus_needs_review_batches: Number(run.needs_review_batches || 0)
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
      `- OCR済み記事数: ${Number(run.ocr_ready_article_count || 0) || '未確認'}`,
      `- 本文読解済み記事数: ${Number(run.analyzed_article_count || 0)}`,
      `- 完了バッチ: ${Number(run.completed_batches || 0)} / ${Number(run.total_batches || 0)}`,
      `- 失敗バッチ: ${Number(run.failed_batches || 0)}`,
      `- 要レビューBatch: ${Number(run.needs_review_batches || 0)}`,
      '',
      '## 3. 必要な対応',
      '/corpus-scans でrunを作成し、全バッチをcompletedにしてください。'
    ].join('\n')
  };
  let report = null;
  let report_error = '';
  try {
    const saved = await supabaseAdmin.from('chat_reports').insert({ user_query: query, answer_text: answer.answer_text, answer_json: answer, related_article_ids: articles.map((a) => a.id) }).select('*').single();
    if (saved.error) throw saved.error;
    report = saved.data;
  } catch (error) {
    report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
  }
  return { report, report_error, related_articles: articles, selectable_models: [], answer };
}

export async function runChatAnalysis(body: Record<string, unknown>, onProgress?: ProgressReporter) {
  const query = text(body.query);
  if (!wantsAll(body) || body.require_full_corpus === false) return runBaseChatAnalysis(body, onProgress);
  await onProgress?.({ progress: 12, stage: '全件本文読解ゲートを確認中' });
  const context = await getFullCorpusContext('all', '');
  if (!passed(context)) {
    const result = await diagnostic(query, body, context);
    await onProgress?.({ progress: 100, stage: '全件本文読解未完了' });
    return result;
  }
  const conversation = Array.isArray(body.conversation) ? body.conversation : [];
  const result = await runBaseChatAnalysis({ ...body, conversation: [...conversation, ...corpusMessage(context)], full_corpus_gate: 'passed' }, onProgress);
  if (isRecord(result) && isRecord(result.answer)) {
    const run = isRecord(context.run) ? context.run : {};
    result.answer.full_corpus_gate = 'passed';
    result.answer.full_corpus_run_id = text(run.id);
    result.answer.source_coverage = { ...(isRecord(result.answer.source_coverage) ? result.answer.source_coverage : {}), full_corpus_gate: 'passed', full_corpus_run_id: text(run.id), full_corpus_analyzed_article_count: Number(run.analyzed_article_count || 0), full_corpus_ocr_ready_article_count: Number(run.ocr_ready_article_count || 0) };
  }
  return result;
}

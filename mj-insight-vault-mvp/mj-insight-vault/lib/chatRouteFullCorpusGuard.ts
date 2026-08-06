import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchAllWideArticles } from '@/lib/wideArticleRetrieval';
import { getBoundedFullCorpusContext } from '@/lib/reportPipeline';
import { getConceptClusters } from '@/lib/conceptClusters';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
const FORMAL_STOP_HEADING = '## 13. 正式レポート保存停止';
type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type JsonRecord = Record<string, unknown>;
type CorpusContext = { run?: JsonRecord | null; context_text?: string; full_corpus_gate?: string };
type Scope = { scopeType: 'all' | 'category'; scopeQuery: string; categoryName?: string };
type ContextMessage = { role: 'user'; content: string };
type ConceptClusterContext = { messages: ContextMessage[]; count: number };

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

async function conceptClusterContext(): Promise<ConceptClusterContext> {
  try {
    const clusters = await getConceptClusters();
    if (!clusters.length) return { messages: [], count: 0 };
    const clusterLines = clusters.slice(0, 20).map((cluster, index) => {
      const members = (cluster.member_summaries || []).slice(0, 3).map((member) => {
        const summary = text(member.summary_text).replace(/\s+/g, ' ').slice(0, 140);
        return `- ${member.headline || '無題の記事'} (/articles/${member.article_id}): ${summary}`;
      }).join('\n');
      return [
        `${index + 1}. ${cluster.cluster_label || `クラスタ${cluster.cluster_index + 1}`} (${cluster.total_articles}件; months: ${(cluster.source_rollup_months || []).join(', ') || '-'})`,
        cluster.cluster_description ? `説明: ${cluster.cluster_description}` : '',
        members ? `代表記事:\n${members}` : ''
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    return {
      count: clusters.length,
      messages: [{
        role: 'user',
        content: [
          '【ANALYSIS_LAYER_2_CONCEPT_CLUSTERS】',
          '以下は evidence_matrix と article_embeddings から生成した横断クラスタです。月別rollupとは別の第2分析レイヤーとして、全体傾向の整理・反証・コンセプト候補抽出に使ってください。',
          'ただし、クラスタは中間解釈レイヤーです。最終的な根拠引用は記事リンク・記事ID・月別rollupで確認してください。',
          `cluster_count: ${clusters.length}`,
          clusterLines
        ].join('\n')
      }]
    };
  } catch {
    return { messages: [], count: 0 };
  }
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
    report_kind: 'diagnostic',
    generation_status: 'blocked',
    is_formal_report: false,
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
      '永続レポートジョブから実行すると、本文読解runの作成・再構築・再開を自動で行います。'
    ].join('\n')
  };
  return { report: null, report_error: 'full_corpus_gate_failed', related_articles: [], selectable_models: [], answer };
}

function removeStaleFormalStop(value: unknown) {
  const body = text(value);
  const index = body.indexOf(FORMAL_STOP_HEADING);
  return index >= 0 ? body.slice(0, index).trim() : body;
}

function clearPriorGate(answer: JsonRecord) {
  delete answer.raw_quality_gate;
  delete answer.quality_gate;
  delete answer.formal_gate_version;
  delete answer.display_enrichment;
  delete answer.formal_report_ready;
}

function formalGatePassed(answer: JsonRecord) {
  const rawGate = isRecord(answer.raw_quality_gate) ? answer.raw_quality_gate : {};
  return text(answer.full_corpus_gate) === 'passed'
    && answer.analysis_is_provisional !== true
    && text(rawGate.version) === 'formal_gate_v2'
    && text(rawGate.validation_mode) === 'raw_before_enrichment'
    && text(rawGate.status) === 'passed';
}

function finalizePassedResult(result: JsonRecord, context: CorpusContext, scope: Scope, clusterCount: number) {
  if (!isRecord(result.answer)) return result;
  const run = isRecord(context.run) ? context.run : {};
  const answer: JsonRecord = { ...result.answer };
  const sourceCoverage = isRecord(answer.source_coverage) ? { ...answer.source_coverage } : {};
  const coverageDiagnosis = isRecord(answer.coverage_diagnosis) ? { ...answer.coverage_diagnosis } : {};

  clearPriorGate(answer);
  answer.answer_text = removeStaleFormalStop(answer.answer_text);
  answer.full_corpus_gate = 'passed';
  answer.analysis_is_provisional = false;
  answer.target_scope = scope.scopeType;
  answer.category_id = scope.scopeQuery;
  answer.full_corpus_run_id = text(run.id);
  answer.analysis_layer_2_clusters_used = clusterCount > 0;
  answer.analysis_layer_2_cluster_count = clusterCount;
  answer.source_coverage = {
    ...sourceCoverage,
    scope_type: scope.scopeType,
    scope_query: scope.scopeQuery,
    full_corpus_gate: 'passed',
    analysis_is_provisional: false,
    full_corpus_run_id: text(run.id),
    full_corpus_analyzed_article_count: num(run, 'analyzed_article_count'),
    full_corpus_ocr_ready_article_count: num(run, 'ocr_ready_article_count'),
    analysis_layer_2_clusters_used: clusterCount > 0,
    analysis_layer_2_cluster_count: clusterCount
  };
  answer.coverage_diagnosis = {
    ...coverageDiagnosis,
    full_corpus_gate: 'passed',
    analysis_is_provisional: false,
    full_corpus_run_id: text(run.id)
  };

  const finalized = enhanceChatAnalysisResult({ ...result, answer }) as JsonRecord;
  if (isRecord(finalized.answer) && formalGatePassed(finalized.answer)) {
    finalized.answer.report_kind = 'formal';
    finalized.answer.generation_status = 'completed';
    finalized.answer.is_formal_report = true;
    finalized.answer.analysis_verification_status = 'full_corpus_verified';
    finalized.report_error = null;
  }
  return finalized;
}

function relatedArticleIds(result: JsonRecord) {
  const related = Array.isArray(result.related_articles) ? result.related_articles : [];
  return related.filter(isRecord).map((item) => text(item.id || item.article_id)).filter(Boolean);
}

async function persistFinalizedResult(result: JsonRecord, body: JsonRecord) {
  if (!isRecord(result.answer)) return result;
  const sourceJobId = text(body.source_job_id);
  const safe = sanitizeReportForDisplay({
    user_query: text(body.query),
    answer_text: text(result.answer.answer_text) || JSON.stringify(result.answer),
    answer_json: result.answer
  });

  if (isRecord(result.report) && text(result.report.id)) {
    const patch: JsonRecord = {
      answer_text: text(safe.answer_text),
      answer_json: safe.answer_json
    };
    if (sourceJobId) patch.source_job_id = sourceJobId;
    const { data, error } = await supabaseAdmin
      .from('chat_reports')
      .update(patch)
      .eq('id', text(result.report.id))
      .select('*')
      .single();
    if (error) throw error;
    result.report = data;
    return result;
  }

  if (!formalGatePassed(result.answer)) return result;

  const payload: JsonRecord = {
    user_query: text(safe.user_query),
    answer_text: text(safe.answer_text),
    answer_json: safe.answer_json,
    related_article_ids: relatedArticleIds(result)
  };
  if (sourceJobId) payload.source_job_id = sourceJobId;
  const { data, error } = await supabaseAdmin
    .from('chat_reports')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw error;
  result.report = data;
  result.report_error = null;
  return result;
}

export async function runChatAnalysis(body: JsonRecord, onProgress?: ProgressReporter) {
  const query = text(body.query);
  const scope = await resolveScope(body);
  if (!shouldGuard(body, scope)) return runBaseChatAnalysis(body, onProgress);
  await onProgress?.({ progress: 12, stage: scope.scopeType === 'category' ? 'カテゴリ本文読解ゲートを確認中' : '全件本文読解ゲートを確認中' });
  const context = await getBoundedFullCorpusContext(scope.scopeType, scope.scopeQuery) as CorpusContext;
  const clusterContext = await conceptClusterContext();
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
    conversation: [...conversation, ...corpusMessage(context, scope), ...clusterContext.messages],
    full_corpus_gate: 'passed'
  };
  const baseResult = await runBaseChatAnalysis(routedBody, onProgress) as JsonRecord;
  const finalized = finalizePassedResult(baseResult, context, scope, clusterContext.count);
  return persistFinalizedResult(finalized, body);
}

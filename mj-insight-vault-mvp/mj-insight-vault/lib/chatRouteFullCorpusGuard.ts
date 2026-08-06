import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fetchAllWideArticles } from '@/lib/wideArticleRetrieval';
import { getIntegrityCheckedFullCorpusContext, type FullCorpusIntegrityContext } from '@/lib/fullCorpusIntegrity';
import { getConceptClusters } from '@/lib/conceptClusters';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
const FORMAL_STOP_HEADING = '## 13. 正式レポート保存停止';
type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type JsonRecord = Record<string, unknown>;
type CorpusContext = FullCorpusIntegrityContext;
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
    && context.full_corpus_integrity_gate === 'passed'
    && context.integrity_failures.length === 0
    && Boolean(text(context.context_text))
    && context.prompt_version === 'full_corpus_batch_v2'
    && context.omitted_batches === 0
    && context.represented_batches === num(run, 'total_batches')
    && context.represented_article_count === num(run, 'analyzed_article_count')
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
  const rules = [
    'この入力は全バッチを均等に圧縮した最終統合用コンテキストです。先頭バッチだけを優先しないでください。',
    '各バッチの観察、反証、調査課題を横断し、頻度と反例を区別してください。',
    '企業施策を生活者需要の証明へ変換しないでください。'
  ];
  if (scope.scopeType === 'category') {
    return [{ role: 'user', content: [
      `【CATEGORY_FULL_CORPUS_BATCH_ANALYSIS_PRIMARY:${scope.scopeQuery}】`,
      ...rules,
      'カテゴリ外の記事は比較・反証目的以外では主要根拠に使わないでください。',
      contextText
    ].join('\n') }];
  }
  return [{ role: 'user', content: ['【FULL_CORPUS_BATCH_ANALYSIS_PRIMARY】', ...rules, contextText].join('\n') }];
}

async function conceptClusterContext(run: JsonRecord): Promise<ConceptClusterContext> {
  try {
    const fingerprint = text(run.corpus_fingerprint);
    const clusters = (await getConceptClusters()).filter((cluster) => {
      const params = isRecord(cluster.generation_params) ? cluster.generation_params : {};
      return params.integrity_verified === true
        && text(params.corpus_fingerprint) === fingerprint
        && text(params.labeling) !== 'temporary_no_llm'
        && params.manual_labeling !== true;
    });
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
          '以下は現在の全件runと同一fingerprintで検証された横断クラスタです。',
          'クラスタは中間解釈レイヤーであり、最終根拠は記事IDで確認してください。',
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
  const failures = context.integrity_failures.slice(0, 20);
  const answer = {
    report_title: `${scopeLabel}分析整合性未達`,
    report_kind: 'diagnostic',
    generation_status: 'blocked',
    is_formal_report: false,
    target_scope: scope.scopeType,
    category_id: scope.scopeType === 'category' ? scope.scopeQuery : '',
    model_used: text(body.model || ''),
    full_corpus_gate: context.full_corpus_gate,
    full_corpus_integrity_gate: context.full_corpus_integrity_gate,
    analysis_is_provisional: true,
    related_article_count: allArticles.length,
    article_count_scanned: allArticles.length,
    source_coverage: {
      active_article_count: allArticles.length,
      scanned_article_count: allArticles.length,
      scope_type: scope.scopeType,
      scope_query: scope.scopeQuery,
      full_corpus_gate: context.full_corpus_gate,
      full_corpus_integrity_gate: context.full_corpus_integrity_gate,
      integrity_failures: failures,
      full_corpus_prompt_version: context.prompt_version,
      final_context_all_batches_represented: context.omitted_batches === 0,
      final_context_represented_batches: context.represented_batches,
      final_context_represented_article_count: context.represented_article_count,
      full_corpus_run_id: text(run.id),
      full_corpus_analyzed_article_count: num(run, 'analyzed_article_count'),
      full_corpus_ocr_ready_article_count: num(run, 'ocr_ready_article_count'),
      full_corpus_total_batches: num(run, 'total_batches'),
      full_corpus_completed_batches: num(run, 'completed_batches'),
      full_corpus_failed_batches: num(run, 'failed_batches'),
      full_corpus_needs_review_batches: num(run, 'needs_review_batches')
    },
    quality_gate: { status: 'failed', failed_checks: ['full_corpus_integrity_gate', ...failures] },
    answer_text: [
      '## 1. 結論',
      `${scopeLabel}の件数ゲートまたは内容整合性ゲートが未達のため、正式分析レポートは生成していません。`,
      '',
      '## 2. 状態',
      `- 指示: ${query}`,
      `- scan_run_id: ${text(run.id) || '未作成'}`,
      `- count gate: ${context.full_corpus_gate}`,
      `- integrity gate: ${context.full_corpus_integrity_gate}`,
      `- prompt version: ${context.prompt_version}`,
      `- 最終統合で表現されたバッチ: ${context.represented_batches} / ${num(run, 'total_batches')}`,
      `- 最終統合で表現された記事レコード: ${context.represented_article_count} / ${num(run, 'analyzed_article_count')}`,
      '',
      '## 3. 整合性エラー',
      ...(failures.length ? failures.map((failure) => `- ${failure}`) : ['- count gate未達']),
      '',
      '## 4. 必要な対応',
      '正式母集団をarticle型に限定し、full_corpus_batch_v2で全バッチを再構築してください。'
    ].join('\n')
  };
  return { report: null, report_error: 'full_corpus_integrity_gate_failed', related_articles: [], selectable_models: [], answer };
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
  const source = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  return text(answer.full_corpus_gate) === 'passed'
    && text(answer.full_corpus_integrity_gate || source.full_corpus_integrity_gate) === 'passed'
    && text(answer.full_corpus_prompt_version || source.full_corpus_prompt_version) === 'full_corpus_batch_v2'
    && (answer.final_context_all_batches_represented ?? source.final_context_all_batches_represented) === true
    && Number(answer.final_context_omitted_batches ?? source.final_context_omitted_batches ?? 0) === 0
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
  const integrity = {
    full_corpus_integrity_gate: context.full_corpus_integrity_gate,
    full_corpus_prompt_version: context.prompt_version,
    final_context_all_batches_represented: context.omitted_batches === 0,
    final_context_represented_batches: context.represented_batches,
    final_context_represented_article_count: context.represented_article_count,
    final_context_omitted_batches: context.omitted_batches
  };

  clearPriorGate(answer);
  answer.answer_text = removeStaleFormalStop(answer.answer_text);
  answer.full_corpus_gate = 'passed';
  Object.assign(answer, integrity);
  answer.analysis_is_provisional = false;
  answer.target_scope = scope.scopeType;
  answer.category_id = scope.scopeQuery;
  answer.full_corpus_run_id = text(run.id);
  answer.analysis_layer_2_clusters_used = clusterCount > 0;
  answer.analysis_layer_2_cluster_count = clusterCount;
  answer.source_coverage = {
    ...sourceCoverage,
    ...integrity,
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
    ...integrity,
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
  await onProgress?.({ progress: 12, stage: scope.scopeType === 'category' ? 'カテゴリ本文読解整合性を確認中' : '全件本文読解整合性を確認中' });
  const context = await getIntegrityCheckedFullCorpusContext(scope.scopeType, scope.scopeQuery);
  const run = isRecord(context.run) ? context.run : {};
  const clusterContext = passed(context) ? await conceptClusterContext(run) : { messages: [], count: 0 };
  if (!passed(context)) {
    const result = await diagnostic(query, body, context, scope);
    await onProgress?.({ progress: 100, stage: '全件分析整合性未達' });
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
    full_corpus_gate: 'passed',
    full_corpus_integrity_gate: 'passed',
    full_corpus_prompt_version: context.prompt_version,
    final_context_all_batches_represented: true
  };
  const baseResult = await runBaseChatAnalysis(routedBody, onProgress) as JsonRecord;
  const finalized = finalizePassedResult(baseResult, context, scope, clusterContext.count);
  return persistFinalizedResult(finalized, body);
}

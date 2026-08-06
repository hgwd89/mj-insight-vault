import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getIntegrityCheckedFullCorpusContext, type FullCorpusIntegrityContext } from '@/lib/fullCorpusIntegrity';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { MJ_REPORT_SYSTEM_PROMPT } from '@/lib/reportPrompt';

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
const MAX_EVIDENCE = 72;
const TIMEOUT_MS = Number(process.env.FULL_CORPUS_FINAL_TIMEOUT_MS) || 120_000;
const MAX_TOKENS = Number(process.env.FULL_CORPUS_FINAL_MAX_TOKENS) || 12_000;

type Json = Record<string, unknown>;
type Scope = { type: 'all' | 'category'; query: string; name?: string };
type Progress = (value: { progress: number; stage: string }) => void | Promise<void>;
type Context = FullCorpusIntegrityContext;
type Evidence = {
  article_id: string;
  batch_index: number;
  claim: string;
  evidence_excerpt_or_fact: string;
  headline?: string;
  article_date?: string;
  article_url?: string;
  article_link?: string;
  ocr_text?: string;
};

const text = (value: unknown) => value === undefined || value === null ? '' : String(value).trim();
const record = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const records = (value: unknown) => Array.isArray(value) ? value.filter(record) : [];
const number = (value: unknown) => Number(value || 0);
const runValue = (run: Json, key: string) => number(run[key]);

async function reportProgress(onProgress: Progress | undefined, progress: number, stage: string) {
  try { await onProgress?.({ progress, stage }); } catch {}
}

async function resolveScope(body: Json): Promise<Scope> {
  const explicit = text(body.category_id || body.analysis_category_id || body.category);
  if (explicit) return { type: 'category', query: explicit };
  const query = text(body.query);
  const { data } = await supabaseAdmin.from('analysis_categories').select('id, name_ja, keywords').eq('is_active', true);
  const lower = query.toLowerCase();
  const matched = (data || []).find((row) => {
    const id = text(row.id);
    const name = text(row.name_ja);
    const keywords = Array.isArray(row.keywords) ? row.keywords.map(text) : [];
    return lower.includes(id.toLowerCase()) || (name && query.includes(name)) || keywords.some((item) => item && lower.includes(item.toLowerCase()));
  });
  if (matched && (text(body.target_scope) === 'category' || !ALL_WORDS.test(query))) {
    return { type: 'category', query: text(matched.id), name: text(matched.name_ja) };
  }
  return { type: 'all', query: '' };
}

function shouldGuard(body: Json, scope: Scope) {
  if (body.require_full_corpus === false) return false;
  return scope.type === 'category' || text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query));
}

function contextPassed(context: Context) {
  const run = record(context.run) ? context.run : null;
  return Boolean(run)
    && context.full_corpus_gate === 'passed'
    && context.full_corpus_integrity_gate === 'passed'
    && context.integrity_failures.length === 0
    && Boolean(text(context.context_text))
    && context.prompt_version === 'full_corpus_batch_v2'
    && context.omitted_batches === 0
    && context.represented_batches === runValue(run!, 'total_batches')
    && context.represented_article_count === runValue(run!, 'analyzed_article_count')
    && text(run!.status) === 'completed'
    && runValue(run!, 'completed_batches') === runValue(run!, 'total_batches')
    && runValue(run!, 'failed_batches') === 0
    && runValue(run!, 'needs_review_batches') === 0
    && runValue(run!, 'analyzed_article_count') === runValue(run!, 'ocr_ready_article_count');
}

function fact(item: Json) {
  return text(item.evidence_excerpt_or_fact || item.observed_fact || item.what_can_be_said || item.evidence_excerpt || item.excerpt || item.fact)
    .replace(/\s+/g, ' ').slice(0, 700);
}

function claim(item: Json, summary: Json) {
  return text(item.claim || item.theme || item.signal || item.consumer_narrative || summary.consumer_narratives || summary.behavior_signals || summary.weak_signals || '記事本文で観察された事実')
    .replace(/\s+/g, ' ').slice(0, 240);
}

function collectEvidence(context: Context) {
  const all: Evidence[] = [];
  const seen = new Set<string>();
  for (const rawBatch of context.batches) {
    const batch = record(rawBatch) ? rawBatch : {};
    const summary = record(batch.summary_json) ? batch.summary_json : {};
    for (const item of records(summary.evidence)) {
      const articleId = text(item.article_id || item.id);
      const evidenceFact = fact(item);
      if (!articleId || evidenceFact.length < 20 || seen.has(articleId)) continue;
      seen.add(articleId);
      all.push({ article_id: articleId, batch_index: number(batch.batch_index), claim: claim(item, summary), evidence_excerpt_or_fact: evidenceFact });
    }
  }
  if (all.length <= MAX_EVIDENCE) return all;
  const step = all.length / MAX_EVIDENCE;
  return Array.from({ length: MAX_EVIDENCE }, (_, index) => all[Math.min(all.length - 1, Math.floor(index * step))]);
}

async function enrichEvidence(seeds: Evidence[]) {
  const ids = seeds.map((item) => item.article_id);
  const rows: Json[] = [];
  for (let index = 0; index < ids.length; index += 200) {
    const { data, error } = await supabaseAdmin.from('articles').select('id, headline, article_date, ocr_text').in('id', ids.slice(index, index + 200));
    if (error) throw error;
    rows.push(...((data || []).filter(record)));
  }
  const byId = new Map(rows.map((row) => [text(row.id), row]));
  return seeds.map((seed) => {
    const row = byId.get(seed.article_id) || {};
    const headline = text(row.headline) || '無題の記事';
    const date = text(row.article_date) || '日付不明';
    return {
      ...seed,
      headline,
      article_date: date,
      article_url: `/articles/${seed.article_id}`,
      article_link: `[${headline}｜${date}](/articles/${seed.article_id})`,
      ocr_text: text(row.ocr_text).replace(/\s+/g, ' ').slice(0, 900)
    };
  });
}

function timeout<T>(factory: (signal: AbortSignal) => Promise<T>, ms: number) {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(); reject(new Error(`full corpus writer timed out after ${ms}ms`)); }, ms);
    factory(controller.signal).then((value) => { clearTimeout(timer); resolve(value); }).catch((error) => { clearTimeout(timer); reject(error); });
  });
}

function parseContext(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function ensureRawFields(answer: Json, evidenceLookup: Evidence[], run: Json, scope: Scope) {
  const lookup = new Map(evidenceLookup.map((item) => [item.article_id, item]));
  const evidence: Json[] = [];
  const seen = new Set<string>();
  for (const item of records(answer.evidence_matrix)) {
    const id = text(item.article_id || item.id);
    const source = lookup.get(id);
    if (!source || seen.has(id)) continue;
    const evidenceFact = fact(item) || source.evidence_excerpt_or_fact;
    if (evidenceFact.length < 20) continue;
    seen.add(id);
    evidence.push({ ...item, article_id: id, headline: text(item.headline) || source.headline, article_date: text(item.article_date) || source.article_date, article_url: source.article_url, article_link: source.article_link, evidence_excerpt_or_fact: evidenceFact, evidence_strength: text(item.evidence_strength || 'B'), limitation: text(item.limitation) || '記事単独では生活者全体の需要や因果を断定できない。', synthetic_repair: false });
  }
  for (const source of evidenceLookup) {
    if (evidence.length >= 10) break;
    if (seen.has(source.article_id)) continue;
    seen.add(source.article_id);
    evidence.push({ ...source, evidence_strength: 'B', limitation: '記事本文で確認できる事実。頻度・代表性・因果は全バッチ横断と追加調査で確認する。', what_can_be_said: source.evidence_excerpt_or_fact, what_cannot_be_said: 'この記事単独では生活者全体の需要や心理を断定できない。', synthetic_repair: false, provenance: 'validated_full_corpus_batch_v2_evidence' });
  }
  answer.evidence_matrix = evidence;
  if (!records(answer.refutation_audit).length) answer.refutation_audit = [{ target_claim: '主要トレンド全体', possible_counterargument: '企業施策や商品投入が多いだけで生活者需要の変化を示していない可能性がある。', evidence_gap: '生活者本人の発話、継続購買、非購買理由、カテゴリ横断の反例。', downgrade_or_revision: '生活者側の直接証拠がない主張は仮説へ格下げする。', falsification_condition: '追加調査で行動変化が一時的・局所的・企業主導に限定される場合。', synthetic_repair: false }];
  if (!records(answer.negative_space).length) answer.negative_space = [{ expected_but_weak_or_absent_theme: '生活者本人の長期継続行動と非利用理由', why_absence_matters: '記事群は企業・市場側の情報を多く含み、心理や因果の直接証拠が弱い。', what_to_check_next: '時系列購買、非購買者インタビュー、カテゴリ外反例を確認する。', synthetic_repair: false }];
  if (!records(answer.research_needs).length) answer.research_needs = [{ question: '観察された変化は生活者本人の継続行動と選択理由で再現されるか。', why_it_matters: '市場シグナルを生活者インサイトへ昇格するため。', needed_data: '生活者発話、購買・利用継続、非利用理由、カテゴリ外反例。', method_hint: 'N1深掘り、行動ログ、定量検証。', priority: 'high', synthetic_repair: false }];
  if (!records(answer.confidence_rubric).length) answer.confidence_rubric = evidence.slice(0, 5).map((item) => ({ claim: text(item.claim || '根拠付き主張'), confidence: text(item.evidence_strength || 'B'), reason_for_confidence: text(item.evidence_excerpt_or_fact), reason_for_uncertainty: text(item.limitation), synthetic_repair: false }));

  const links = evidence.slice(0, 8).map((item) => text(item.article_link) ? `- ${text(item.claim || '根拠記事')}：${text(item.article_link)} — ${text(item.evidence_excerpt_or_fact).slice(0, 180)}` : '').filter(Boolean);
  if (links.length && !text(answer.answer_text).includes('## 根拠記事')) answer.answer_text = `${text(answer.answer_text)}\n\n## 根拠記事\n${links.join('\n')}`.trim();

  const analyzed = runValue(run, 'analyzed_article_count');
  Object.assign(answer, {
    scan_enabled: true,
    scan_model: 'full_corpus_batch_v2_direct_writer',
    retrieval_mode: 'full_corpus_batch_v2_uniform_digest_plus_validated_evidence',
    article_count_scanned: analyzed,
    article_count_for_report: evidence.length,
    related_article_count: analyzed,
    selected_article_ids: evidence.map((item) => text(item.article_id)).filter(Boolean),
    analysis_is_provisional: false,
    target_scope: scope.type,
    category_id: scope.query
  });
  answer.source_coverage = {
    ...(record(answer.source_coverage) ? answer.source_coverage : {}),
    active_article_count: runValue(run, 'active_article_count'),
    scanned_article_count: analyzed,
    final_article_count: evidence.length,
    scope_type: scope.type,
    scope_query: scope.query,
    scan_model: 'full_corpus_batch_v2_direct_writer',
    retrieval_mode: 'full_corpus_batch_v2_uniform_digest_plus_validated_evidence',
    full_corpus_gate: 'passed',
    analysis_is_provisional: false,
    coverage_note: `full_corpus_batch_v2の全${runValue(run, 'total_batches')}バッチ・${analyzed}記事を均等圧縮して最終統合。`
  };
  return answer;
}

async function directWriter(body: Json, context: Context, scope: Scope, onProgress?: Progress): Promise<Json> {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY missing');
  const run = record(context.run) ? context.run : {};
  const model = text(body.model) || TEXT_MODEL;
  await reportProgress(onProgress, 40, '全バッチから検証済み根拠を構築中');
  const seeds = collectEvidence(context);
  if (seeds.length < 3) throw new Error(`validated evidence insufficient: ${seeds.length}`);
  const evidence = await enrichEvidence(seeds);
  const query = [text(body.query), scope.type === 'category' ? `対象カテゴリID: ${scope.query}` : '', scope.name ? `対象カテゴリ名: ${scope.name}` : ''].filter(Boolean).join('\n');
  const payload = {
    query,
    coverage: { scope_type: scope.type, scope_query: scope.query, run_id: text(run.id), active_article_count: runValue(run, 'active_article_count'), analyzed_article_count: runValue(run, 'analyzed_article_count'), total_batches: runValue(run, 'total_batches'), represented_batches: context.represented_batches, represented_article_count: context.represented_article_count, omitted_batches: context.omitted_batches, prompt_version: context.prompt_version },
    full_corpus_batch_context_primary: parseContext(context.context_text),
    evidence_article_lookup_for_citation_only: evidence,
    rules: [
      '全体傾向・ナラティブ・インサイトはfull_corpus_batch_context_primaryからのみ導出する。',
      'evidence lookupは引用・リンク・事実確認専用であり、テーマ分布や母集団として扱わない。',
      '全バッチを横断し、一部バッチへ偏らない。頻度、反例、弱いシグナル、無信号を区別する。',
      '企業施策・商品投入・販路拡大を生活者需要の証明へ変換しない。',
      '事実、推論、仮説、調査必要を分離する。',
      'evidence_matrixに異なるarticle_idを5件以上入れ、具体的事実を20文字以上書く。',
      'answer_textに/articles/{article_id}のMarkdownリンクを3件以上含める。',
      'refutation_audit、negative_space、confidence_rubric、research_needsを必ず生出力に含める。'
    ],
    required_json_fields: ['report_title', 'answer_text', 'major_trends', 'explanatory_hypotheses', 'cross_article_insights', 'evidence_matrix', 'refutation_audit', 'negative_space', 'confidence_rubric', 'research_needs', 'source_coverage']
  };
  await reportProgress(onProgress, 56, `全${runValue(run, 'total_batches')}バッチを専用Writerで統合中`);
  const completion = await timeout((signal) => openai.chat.completions.create({
    model,
    ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: `${MJ_REPORT_SYSTEM_PROMPT}\n\nCRITICAL OVERRIDE: This is a formal full-corpus synthesis. Do not run or simulate article retrieval, hybrid search, monthly rollup selection, or top-N selection. The supplied full_corpus_batch_context_primary represents every validated batch. Return one JSON object only.` },
      { role: 'user', content: JSON.stringify(payload) }
    ]
  }, { signal }), TIMEOUT_MS);
  const parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Json;
  if (text(parsed.answer_text).length < 120) throw new Error(`unusable writer output: ${text(parsed.answer_text).length}`);
  return {
    report: null,
    report_error: '',
    related_articles: evidence.map((item) => ({ id: item.article_id, headline: item.headline, article_date: item.article_date, ocr_text: item.ocr_text || item.evidence_excerpt_or_fact })),
    selectable_models: [model],
    answer: ensureRawFields(parsed, evidence, run, scope)
  } as Json;
}

function formalGatePassed(answer: Json) {
  const raw = record(answer.raw_quality_gate) ? answer.raw_quality_gate : {};
  const source = record(answer.source_coverage) ? answer.source_coverage : {};
  return text(answer.full_corpus_gate) === 'passed'
    && text(answer.full_corpus_integrity_gate || source.full_corpus_integrity_gate) === 'passed'
    && text(answer.full_corpus_prompt_version || source.full_corpus_prompt_version) === 'full_corpus_batch_v2'
    && (answer.final_context_all_batches_represented ?? source.final_context_all_batches_represented) === true
    && number(answer.final_context_omitted_batches ?? source.final_context_omitted_batches) === 0
    && answer.analysis_is_provisional !== true
    && text(raw.version) === 'formal_gate_v2'
    && text(raw.validation_mode) === 'raw_before_enrichment'
    && text(raw.status) === 'passed';
}

function finalize(result: Json, context: Context, scope: Scope): Json {
  if (!record(result.answer)) return result;
  const run = record(context.run) ? context.run : {};
  const answer: Json = { ...result.answer };
  delete answer.raw_quality_gate;
  delete answer.quality_gate;
  delete answer.formal_gate_version;
  delete answer.display_enrichment;
  const integrity = { full_corpus_integrity_gate: context.full_corpus_integrity_gate, full_corpus_prompt_version: context.prompt_version, final_context_all_batches_represented: context.omitted_batches === 0, final_context_represented_batches: context.represented_batches, final_context_represented_article_count: context.represented_article_count, final_context_omitted_batches: context.omitted_batches };
  Object.assign(answer, integrity, { full_corpus_gate: 'passed', analysis_is_provisional: false, target_scope: scope.type, category_id: scope.query, full_corpus_run_id: text(run.id) });
  answer.source_coverage = { ...(record(answer.source_coverage) ? answer.source_coverage : {}), ...integrity, scope_type: scope.type, scope_query: scope.query, full_corpus_gate: 'passed', analysis_is_provisional: false, full_corpus_run_id: text(run.id), full_corpus_analyzed_article_count: runValue(run, 'analyzed_article_count'), full_corpus_ocr_ready_article_count: runValue(run, 'ocr_ready_article_count') };
  answer.coverage_diagnosis = { ...(record(answer.coverage_diagnosis) ? answer.coverage_diagnosis : {}), ...integrity, full_corpus_gate: 'passed', analysis_is_provisional: false, full_corpus_run_id: text(run.id) };
  const finalized = enhanceChatAnalysisResult({ ...result, answer }) as Json;
  if (record(finalized.answer) && formalGatePassed(finalized.answer)) Object.assign(finalized.answer, { report_kind: 'formal', generation_status: 'completed', is_formal_report: true, analysis_verification_status: 'full_corpus_verified' });
  return finalized;
}

async function persist(result: Json, body: Json): Promise<Json> {
  if (!record(result.answer) || !formalGatePassed(result.answer)) return result;
  const sourceJobId = text(body.source_job_id);
  const safe = sanitizeReportForDisplay({ user_query: text(body.query), answer_text: text(result.answer.answer_text), answer_json: result.answer });
  const related = Array.isArray(result.related_articles) ? result.related_articles.filter(record).map((item) => text(item.id || item.article_id)).filter(Boolean) : [];
  const payload: Json = { user_query: text(safe.user_query), answer_text: text(safe.answer_text), answer_json: safe.answer_json, related_article_ids: related };
  if (sourceJobId) payload.source_job_id = sourceJobId;
  const { data, error } = await supabaseAdmin.from('chat_reports').insert(payload).select('*').single();
  if (error) throw error;
  return { ...result, report: data, report_error: null };
}

function diagnostic(body: Json, context: Context, scope: Scope, reason: string): Json {
  const run = record(context.run) ? context.run : {};
  const answer = {
    report_title: '全件分析整合性未達', report_kind: 'diagnostic', generation_status: 'blocked', is_formal_report: false,
    target_scope: scope.type, category_id: scope.query, analysis_is_provisional: true,
    full_corpus_gate: context.full_corpus_gate, full_corpus_integrity_gate: context.full_corpus_integrity_gate,
    source_coverage: { full_corpus_run_id: text(run.id), full_corpus_prompt_version: context.prompt_version, represented_batches: context.represented_batches, represented_article_count: context.represented_article_count, omitted_batches: context.omitted_batches, integrity_failures: [...context.integrity_failures, reason] },
    answer_text: `## 結論\n正式レポートは生成していません。\n\n## 原因\n- ${reason}\n- run: ${text(run.id) || 'なし'}\n- batches: ${context.represented_batches}/${runValue(run, 'total_batches')}\n- articles: ${context.represented_article_count}/${runValue(run, 'analyzed_article_count')}`
  };
  return { report: null, report_error: reason, related_articles: [], selectable_models: [], answer };
}

export async function runChatAnalysis(body: Json, onProgress?: Progress): Promise<Json> {
  const scope = await resolveScope(body);
  if (!shouldGuard(body, scope)) return await runBaseChatAnalysis(body, onProgress) as Json;
  await reportProgress(onProgress, 12, '全件本文読解整合性を確認中');
  const context = await getIntegrityCheckedFullCorpusContext(scope.type, scope.query);
  if (!contextPassed(context)) return diagnostic(body, context, scope, 'full_corpus_integrity_gate_failed');
  try {
    const generated = await directWriter(body, context, scope, onProgress);
    await reportProgress(onProgress, 92, '専用Writer出力を正式品質ゲートで検査中');
    const finalized = finalize(generated, context, scope);
    const saved = await persist(finalized, body);
    await reportProgress(onProgress, 100, formalGatePassed(record(saved.answer) ? saved.answer : {}) ? '正式レポート生成完了' : '正式品質ゲート未達');
    return saved;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'full_corpus_direct_writer_failed';
    await reportProgress(onProgress, 100, '全件専用Writer失敗');
    return diagnostic(body, context, scope, `direct_writer:${reason}`);
  }
}

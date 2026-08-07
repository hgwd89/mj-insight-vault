import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getIntegrityCheckedFullCorpusContext, type FullCorpusIntegrityContext } from '@/lib/fullCorpusIntegrity';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { MJ_REPORT_SYSTEM_PROMPT } from '@/lib/reportPrompt';

const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;
const FORMAL_STOP_HEADING = '## 13. 正式レポート保存停止';
const MAX_EVIDENCE = 24;
const TIMEOUT_MS = Number(process.env.FULL_CORPUS_FINAL_TIMEOUT_MS) || 125_000;
const MAX_TOKENS = Number(process.env.FULL_CORPUS_FINAL_MAX_TOKENS) || 5_000;

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

const STRUCTURED_TEXT_KEYS = [
  'claim', 'consumer_narrative', 'narrative', 'theme', 'signal', 'insight', 'summary',
  'text', 'title', 'label', 'description', 'observed_fact', 'fact', 'what_can_be_said'
];

function structuredText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return text(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = structuredText(item);
      if (found) return found;
    }
    return '';
  }
  if (record(value)) {
    for (const key of STRUCTURED_TEXT_KEYS) {
      const found = structuredText(value[key]);
      if (found) return found;
    }
  }
  return '';
}

function cleanText(candidates: unknown[], maxLength: number) {
  for (const candidate of candidates) {
    const value = structuredText(candidate).replace(/\s+/g, ' ').replace(/\[object Object\]/gi, '').trim();
    if (value) return value.slice(0, maxLength);
  }
  return '';
}

function brokenText(value: unknown) {
  const normalized = text(value);
  return !normalized || /\[object Object\]|\[object Undefined\]|^undefined$|^null$/i.test(normalized);
}

function stripPriorFormalStop(value: unknown) {
  const body = text(value);
  const index = body.indexOf(FORMAL_STOP_HEADING);
  return index >= 0 ? body.slice(0, index).trim() : body;
}

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
  return cleanText([
    item.evidence_excerpt_or_fact, item.observed_fact, item.what_can_be_said,
    item.evidence_excerpt, item.excerpt, item.fact
  ], 700);
}

function claim(item: Json, summary: Json) {
  return cleanText([
    item.claim, item.theme, item.signal, item.consumer_narrative,
    summary.consumer_narratives, summary.behavior_signals, summary.weak_signals,
    '記事本文で観察された事実'
  ], 240);
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
    const normalizedOcr = text(row.ocr_text).replace(/\s+/g, ' ');
    const seedFact = text(seed.evidence_excerpt_or_fact).replace(/\s+/g, ' ');
    const groundedFact = seedFact && normalizedOcr.includes(seedFact)
      ? seedFact
      : normalizedOcr.slice(0, 360);
    return {
      ...seed,
      headline,
      article_date: date,
      article_url: `/articles/${seed.article_id}`,
      article_link: `[${headline}｜${date}](/articles/${seed.article_id})`,
      evidence_excerpt_or_fact: groundedFact,
      ocr_text: normalizedOcr.slice(0, 500)
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
    const evidenceClaim = cleanText([item.claim, item.theme, item.insight, item.title], 240);
    const evidenceFact = source.evidence_excerpt_or_fact;
    const whatCanBeSaid = cleanText([item.what_can_be_said, evidenceFact], 700);
    const whatCannotBeSaid = cleanText([item.what_cannot_be_said, item.limitation], 700);
    if (evidenceClaim.length < 8 || evidenceFact.length < 20 || whatCanBeSaid.length < 10) continue;
    if (brokenText(evidenceClaim) || brokenText(evidenceFact) || brokenText(whatCanBeSaid)) continue;
    seen.add(id);
    evidence.push({
      ...item,
      claim: evidenceClaim,
      article_id: id,
      headline: text(item.headline) || source.headline,
      article_date: text(item.article_date) || source.article_date,
      article_url: source.article_url,
      article_link: source.article_link,
      evidence_excerpt_or_fact: evidenceFact,
      what_can_be_said: whatCanBeSaid,
      what_cannot_be_said: whatCannotBeSaid || 'この記事単独では生活者全体の需要や因果を断定できない。',
      evidence_strength: text(item.evidence_strength || 'B'),
      limitation: cleanText([item.limitation, whatCannotBeSaid], 700) || '記事単独では生活者全体の需要や因果を断定できない。',
      synthetic_repair: false
    });
  }
  answer.evidence_matrix = evidence;
  answer.answer_text = stripPriorFormalStop(answer.answer_text);

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

// JSON全体を必ず完結させる。
// evidence_matrixは異なるarticle_idを5〜8件に制限する。
async function directWriter(body: Json, context: Context, scope: Scope, onProgress?: Progress): Promise<Json> {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY missing');
  const run = record(context.run) ? context.run : {};
  const model = text(body.model) || TEXT_MODEL;
  const query = [
    text(body.query),
    scope.type === 'category' ? `対象カテゴリID: ${scope.query}` : '',
    scope.name ? `対象カテゴリ名: ${scope.name}` : ''
  ].filter(Boolean).join('\n');

  await reportProgress(onProgress, 35, '全78バッチからレポート本文を統合中');
  const synthesisPayload = {
    query,
    coverage: {
      scope_type: scope.type,
      scope_query: scope.query,
      run_id: text(run.id),
      active_article_count: runValue(run, 'active_article_count'),
      analyzed_article_count: runValue(run, 'analyzed_article_count'),
      total_batches: runValue(run, 'total_batches'),
      represented_batches: context.represented_batches,
      represented_article_count: context.represented_article_count,
      omitted_batches: context.omitted_batches,
      prompt_version: context.prompt_version
    },
    full_corpus_batch_context_primary: parseContext(context.context_text),
    rules: [
      '全体傾向はfull_corpus_batch_context_primaryの全バッチからのみ導出する。',
      '一部バッチや個別記事へ偏らず、頻度、反例、弱いシグナル、無信号を区別する。',
      '企業施策・商品投入・販路拡大を生活者需要の直接証拠へ変換しない。',
      '事実、推論、仮説、追加調査を分離する。',
      'answer_textは日本語1,600〜2,600文字で、結論、主要トレンド、反証・制約、実務含意、調査課題を含める。',
      'この段階では記事リンクやevidence_matrixを書かない。',
      'refutation_auditは2〜4件、negative_spaceは2〜3件、confidence_rubricは3〜5件、research_needsは3〜5件に限定する。',
      'JSON全体を必ず完結させ、重複説明を避ける。'
    ],
    required_json_fields: [
      'report_title', 'answer_text', 'major_trends', 'explanatory_hypotheses',
      'cross_article_insights', 'refutation_audit', 'negative_space',
      'confidence_rubric', 'research_needs', 'source_coverage'
    ]
  };

  const synthesisCompletion = await timeout((signal) => openai.chat.completions.create({
    model,
    ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: `${MJ_REPORT_SYSTEM_PROMPT}\n\nCRITICAL OVERRIDE: Produce a concise formal full-corpus synthesis from every supplied batch digest. Return one complete JSON object only. Do not retrieve or cite individual articles in this stage.`
      },
      { role: 'user', content: JSON.stringify(synthesisPayload) }
    ]
  }, { signal }), TIMEOUT_MS);

  const synthesisRaw = synthesisCompletion.choices[0]?.message.content || '{}';
  let synthesis: Json;
  try {
    synthesis = JSON.parse(synthesisRaw) as Json;
  } catch (error) {
    const detail = error instanceof Error ? error.message : text(error);
    throw new Error(`synthesis JSON invalid or truncated: ${detail}`);
  }

  const synthesisErrors: string[] = [];
  if (text(synthesis.answer_text).length < 800) synthesisErrors.push(`answer_text too short: ${text(synthesis.answer_text).length}`);
  for (const field of ['refutation_audit', 'negative_space', 'confidence_rubric', 'research_needs']) {
    if (!records(synthesis[field]).length) synthesisErrors.push(`${field} missing`);
  }
  if (synthesisErrors.length) throw new Error(`synthesis validation failed: ${synthesisErrors.join('; ')}`);

  await reportProgress(onProgress, 58, '全バッチから接地済み根拠候補を構築中');
  const seeds = collectEvidence(context);
  if (seeds.length < 5) throw new Error(`validated evidence insufficient: ${seeds.length}`);
  const evidenceLookup = await enrichEvidence(seeds);

  const evidencePayload = {
    report_core: {
      report_title: synthesis.report_title,
      answer_text: text(synthesis.answer_text).slice(0, 3600),
      major_trends: synthesis.major_trends,
      explanatory_hypotheses: synthesis.explanatory_hypotheses,
      cross_article_insights: synthesis.cross_article_insights
    },
    evidence_article_lookup: evidenceLookup.map((item) => ({
      article_id: item.article_id,
      headline: item.headline,
      article_date: item.article_date,
      article_link: item.article_link,
      validated_batch_fact: item.evidence_excerpt_or_fact,
      article_text_excerpt: item.ocr_text
    })),
    rules: [
      'report_coreの主要主張を実際に支持または反証する記事を5〜8件だけ選ぶ。',
      'article_idはevidence_article_lookup内だけを使い、重複させない。',
      'claimは15文字以上の分析文にし、記事見出しのコピーは禁止する。',
      'what_can_be_said、what_cannot_be_said、limitationは各10文字以上の日本語文字列にする。',
      '企業施策だけの記事は供給側シグナルとして限定し、生活者需要と断定しない。',
      'evidence_excerpt_or_factは出力しない。引用文はサーバーが記事本文から付与する。',
      'JSONはevidence_matrixだけを持つ完全なオブジェクトとして返す。'
    ],
    required_shape: {
      evidence_matrix: [{
        article_id: 'uuid',
        claim: 'analytical claim',
        what_can_be_said: 'bounded conclusion',
        what_cannot_be_said: 'unsupported conclusion',
        limitation: 'limitation',
        evidence_strength: 'A|B|C'
      }]
    }
  };

  let evidenceSelection: Json[] = [];
  let evidenceFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await reportProgress(onProgress, 64 + (attempt - 1) * 10, `Evidence Criticで根拠を選定中 (${attempt}/2)`);
    const criticPayload = evidenceFeedback.length
      ? { ...evidencePayload, validation_feedback_from_previous_attempt: evidenceFeedback }
      : evidencePayload;
    const criticCompletion = await timeout((signal) => openai.chat.completions.create({
      model,
      ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      response_format: { type: 'json_object' },
      max_completion_tokens: Math.min(MAX_TOKENS, 3_000),
      messages: [
        {
          role: 'system',
          content: 'Return one complete JSON object only. Act as an evidence critic. Select only grounded, relevant and non-duplicated evidence for the supplied report core. Do not write the report body.'
        },
        { role: 'user', content: JSON.stringify(criticPayload) }
      ]
    }, { signal }), TIMEOUT_MS);
    const criticRaw = criticCompletion.choices[0]?.message.content || '{}';
    let critic: Json;
    try {
      critic = JSON.parse(criticRaw) as Json;
    } catch (error) {
      const detail = error instanceof Error ? error.message : text(error);
      evidenceFeedback = [`previous output was invalid or truncated JSON: ${detail}`, 'Return exactly 5 concise evidence objects and complete the JSON.'];
      continue;
    }
    const merged = ensureRawFields({ ...synthesis, evidence_matrix: critic.evidence_matrix }, evidenceLookup, run, scope);
    const candidate = records(merged.evidence_matrix);
    const errors: string[] = [];
    if (candidate.length < 5 || candidate.length > 8) errors.push(`requires 5〜8 valid evidence items; received ${candidate.length}`);
    if (candidate.some((item) => text(item.claim).length < 15)) errors.push('all evidence claims must be at least 15 characters');
    if (candidate.some((item) => brokenText(item.claim) || brokenText(item.what_can_be_said) || brokenText(item.what_cannot_be_said))) errors.push('evidence contains malformed text');
    if (!errors.length) {
      evidenceSelection = candidate;
      break;
    }
    evidenceFeedback = errors;
  }
  if (evidenceSelection.length < 5) throw new Error(`evidence critic validation failed: ${evidenceFeedback.join('; ')}`);

  const evidenceSection = evidenceSelection.map((item) =>
    `- ${text(item.claim)}：${text(item.article_link)} — ${text(item.evidence_excerpt_or_fact).slice(0, 180)}`
  ).join('\n');
  const mergedAnswer = ensureRawFields({
    ...synthesis,
    answer_text: `${stripPriorFormalStop(synthesis.answer_text)}\n\n## 根拠記事\n${evidenceSection}`.trim(),
    evidence_matrix: evidenceSelection,
    generation_path: 'full_corpus_staged_writer_evidence_critic_v1'
  }, evidenceLookup, run, scope);

  const linkCount = (text(mergedAnswer.answer_text).match(/\[[^\]]+\]\(\/articles\/[a-zA-Z0-9_-]+\)/g) || []).length;
  if (linkCount < 3) throw new Error(`answer_text requires at least 3 article links; received ${linkCount}`);

  return {
    report: null,
    report_error: '',
    related_articles: evidenceSelection.map((item) => ({
      id: text(item.article_id),
      headline: text(item.headline),
      article_date: text(item.article_date),
      ocr_text: text(item.evidence_excerpt_or_fact)
    })),
    selectable_models: [model],
    answer: mergedAnswer
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
  answer.analysis_is_provisional = false;
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

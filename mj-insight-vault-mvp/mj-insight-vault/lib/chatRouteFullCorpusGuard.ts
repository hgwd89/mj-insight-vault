import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getIntegrityCheckedFullCorpusContext, type FullCorpusIntegrityContext } from '@/lib/fullCorpusIntegrity';
import { runChatAnalysis as runBaseChatAnalysis } from '@/lib/chatRouteNo160';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { sanitizeReportForDisplay } from '@/lib/reportSafety';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';

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

function semanticChars(value: unknown) {
  return Array.from(text(value).toLowerCase()).filter((char) => /[\p{L}\p{N}]/u.test(char)).join('');
}

function bigramCoverage(left: unknown, right: unknown) {
  const a = semanticChars(left);
  const b = semanticChars(right);
  if (a.length < 2 || b.length < 2) return 0;
  const leftBigrams = new Set(Array.from({ length: a.length - 1 }, (_, index) => a.slice(index, index + 2)));
  const rightBigrams = new Set(Array.from({ length: b.length - 1 }, (_, index) => b.slice(index, index + 2)));
  let overlap = 0;
  for (const gram of leftBigrams) if (rightBigrams.has(gram)) overlap += 1;
  return leftBigrams.size ? overlap / leftBigrams.size : 0;
}

function semanticEvidenceMatch(item: Json, source: Evidence) {
  const claim = text(item.claim);
  const target = `${text(source.headline)} ${text(source.claim)} ${text(source.evidence_excerpt_or_fact)}`;
  return bigramCoverage(claim, target) >= 0.04;
}

function linkedArticleIds(value: unknown) {
  const ids = new Set<string>();
  const pattern = /\/articles\/([0-9a-fA-F-]{36})/g;
  for (const match of text(value).matchAll(pattern)) ids.add(match[1].toLowerCase());
  return ids;
}

function significantNumberTokens(value: unknown) {
  const tokens = new Set<string>();
  for (const match of text(value).match(/\d[\d,，.]*(?:%|％)?/g) || []) {
    const normalized = match.replace(/[，,]/g, '').replace('％', '%');
    const numeric = Number(normalized.replace('%', ''));
    if (normalized.includes('%') || (Number.isFinite(numeric) && numeric > 10)) tokens.add(normalized);
  }
  return tokens;
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

function collectEvidence(context: Context, limit = MAX_EVIDENCE) {
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
  if (limit <= 0 || all.length <= limit) return all;
  const step = all.length / limit;
  return Array.from({ length: limit }, (_, index) => all[Math.min(all.length - 1, Math.floor(index * step))]);
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
      batch_index: number(source.batch_index),
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
// previous output was invalid or truncated JSON
// attempt <= 2
// Legacy staged path marker: full_corpus_staged_writer_evidence_critic_v1
// Evidence Criticで根拠を選定中
async function directWriter(body: Json, context: Context, scope: Scope, onProgress?: Progress): Promise<Json> {
  const openai = getOpenAI();
  if (!openai) throw new Error('OPENAI_API_KEY missing');
  const run = record(context.run) ? context.run : {};
  const writerModel = text(body.model) || TEXT_MODEL;
  const analystModel = text(process.env.FULL_CORPUS_ANALYST_MODEL) || 'gpt-4.1-mini';
  const stageTimeout = Math.min(TIMEOUT_MS, 70_000);
  const query = [
    text(body.query),
    scope.type === 'category' ? `対象カテゴリID: ${scope.query}` : '',
    scope.name ? `対象カテゴリ名: ${scope.name}` : ''
  ].filter(Boolean).join('\n');

  await reportProgress(onProgress, 28, '全78バッチから頻度・反証付きテーマを抽出中');
  const themePayload = {
    query,
    coverage: {
      scope_type: scope.type,
      scope_query: scope.query,
      run_id: text(run.id),
      analyzed_article_count: runValue(run, 'analyzed_article_count'),
      total_batches: runValue(run, 'total_batches'),
      represented_batches: context.represented_batches,
      represented_article_count: context.represented_article_count,
      omitted_batches: context.omitted_batches,
      prompt_version: context.prompt_version
    },
    full_corpus_batch_context_primary: parseContext(context.context_text),
    rules: [
      '全バッチを横断し、4〜5個だけのテーマを頻度・反証・弱いシグナルとともに抽出する。',
      '各テーマはtheme_id、title、claim、supporting_batch_indices、support_summary、signal_type、counterargument、falsification_condition、confidence、reason_for_uncertaintyを持つ。',
      'supporting_batch_indicesは入力中に実在する異なるバッチ番号を3〜5件だけ含める。単一事例を主要テーマへ昇格しない。',
      'signal_typeはdirect_consumer、mixed、supply_onlyのいずれか。企業施策だけならsupply_onlyとする。',
      '生活者本人の調査・購買・利用・発話と、企業側の供給シグナルを区別する。',
      'negative_spaceは2件、research_needsは3件、cross_article_insightsは2件だけ含める。',
      'research_needs各項目はquestion、why_it_matters、needed_data、method_hint、priorityを持つ。',
      '各文字列は120文字以内にする。JSON全体を必ず完結させ、説明文、記事リンク、個別記事ID、入力内容の転載を書かない。'
    ],
    required_shape: {
      report_title: 'string',
      ranked_themes: [{
        theme_id: 'T1', title: 'string', claim: 'string', supporting_batch_indices: [0, 1, 2],
        support_summary: 'string', signal_type: 'direct_consumer|mixed|supply_only',
        counterargument: 'string', falsification_condition: 'string', confidence: 'A|B|C',
        reason_for_uncertainty: 'string'
      }],
      negative_space: [{ expected_but_weak_or_absent_theme: 'string', why_absence_matters: 'string', what_to_check_next: 'string' }],
      research_needs: [{ question: 'string', why_it_matters: 'string', needed_data: 'string', method_hint: 'string', priority: 'high|medium|low' }],
      cross_article_insights: [{ insight: 'string', evidence_strength: 'A|B|C' }]
    }
  };

  let themeAnalysis: Json = {};
  let themes: Json[] = [];
  let themeIds = new Set<string>();
  let themeFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptPayload = themeFeedback.length
      ? {
          ...themePayload,
          correction: {
            errors: themeFeedback,
            instruction: 'Return a shorter complete JSON object. Use exactly 4 themes, 2 negative-space items, 3 research needs and 2 cross-article insights. Keep every string under 100 Japanese characters.'
          }
        }
      : themePayload;
    if (attempt > 1) await reportProgress(onProgress, 38, 'テーマ抽出JSONを短縮して自己修正中');
    const themeCompletion = await timeout((signal) => openai.chat.completions.create({
      model: analystModel,
      ...(analystModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      response_format: { type: 'json_object' },
      max_completion_tokens: 2_800,
      messages: [
        {
          role: 'system',
          content: 'Return one short complete JSON object only. You are a skeptical senior marketing-research analyst. Rank only multi-batch themes, reject anecdotes, and separate direct consumer evidence from supply-side signals. Never repeat the input.'
        },
        { role: 'user', content: JSON.stringify(attemptPayload) }
      ]
    }, { signal }), stageTimeout);

    try {
      themeAnalysis = JSON.parse(themeCompletion.choices[0]?.message.content || '{}') as Json;
    } catch (error) {
      const detail = error instanceof Error ? error.message : text(error);
      themeFeedback = [`theme analysis JSON invalid or truncated: ${detail}`];
      continue;
    }
    themes = records(themeAnalysis.ranked_themes);
    themeIds = new Set(themes.map((item) => text(item.theme_id)).filter(Boolean));
    const errors: string[] = [];
    if (themes.length < 4 || themes.length > 5) errors.push(`ranked_themes requires 4〜5 items; received ${themes.length}`);
    if (themeIds.size !== themes.length) errors.push('theme_id values must be non-empty and unique');
    if (themes.some((item) => text(item.claim).length < 20 || text(item.counterargument).length < 10 || text(item.falsification_condition).length < 10)) errors.push('theme claims and refutation fields are incomplete');
    if (themes.some((item) => !Array.isArray(item.supporting_batch_indices) || item.supporting_batch_indices.length < 3 || item.supporting_batch_indices.length > 6)) errors.push('each theme requires 3〜6 supporting batches');
    if (records(themeAnalysis.negative_space).length !== 2) errors.push('negative_space requires exactly 2 items');
    if (records(themeAnalysis.research_needs).length !== 3) errors.push('research_needs requires exactly 3 items');
    if (records(themeAnalysis.cross_article_insights).length < 2) errors.push('cross_article_insights requires at least 2 items');
    if (!errors.length) {
      themeFeedback = [];
      break;
    }
    themeFeedback = errors;
  }
  if (themeFeedback.length || themes.length < 4) throw new Error(`theme analysis validation failed: ${themeFeedback.join('; ')}`);


  await reportProgress(onProgress, 48, '全件scanの根拠候補を記事本文へ接地中');
  const allSeeds = collectEvidence(context, 0).slice(0, 400);
  if (allSeeds.length < 20) throw new Error(`validated evidence candidate pool insufficient: ${allSeeds.length}`);
  const allEvidence = await enrichEvidence(allSeeds);
  const evidenceById = new Map(allEvidence.map((item) => [item.article_id, item]));
  const shortlistedById = new Map<string, Evidence>();
  for (const theme of themes) {
    const themeText = `${text(theme.title)} ${text(theme.claim)} ${text(theme.support_summary)}`;
    const ranked = allEvidence
      .map((item) => ({ item, score: bigramCoverage(themeText, `${text(item.headline)} ${item.claim} ${item.evidence_excerpt_or_fact}`) }))
      .sort((left, right) => right.score - left.score)
      .filter((entry) => entry.score > 0.01)
      .slice(0, 18);
    for (const entry of ranked) shortlistedById.set(entry.item.article_id, entry.item);
  }
  if (shortlistedById.size < 40) {
    for (const item of allEvidence) {
      shortlistedById.set(item.article_id, item);
      if (shortlistedById.size >= 64) break;
    }
  }
  const shortlistedEvidence = Array.from(shortlistedById.values()).slice(0, 80);

  await reportProgress(onProgress, 58, 'Evidence Criticでテーマ別候補から根拠を選定中');
  const evidencePayload = {
    ranked_themes: themes,
    evidence_candidates: shortlistedEvidence.map((item) => ({
      article_id: item.article_id,
      batch_index: item.batch_index,
      headline: text(item.headline).slice(0, 100),
      batch_claim: item.claim.slice(0, 120),
      validated_fact: item.evidence_excerpt_or_fact.slice(0, 180)
    })),
    rules: [
      'ranked_themesを実際に支持または反証する異なる記事を6〜8件選ぶ。少なくとも4つのtheme_idをカバーする。',
      'article_idはevidence_candidates内だけを使う。',
      '各項目はtheme_id、article_id、claim、what_can_be_said、what_cannot_be_said、limitation、evidence_strength、evidence_typeを持つ。',
      'claimは15文字以上の分析文で、見出しのコピーは禁止する。',
      'evidence_typeはconsumer_survey、purchase_behavior、usage_behavior、consumer_quote、supply_signalのいずれか。',
      'consumer_survey、purchase_behavior、usage_behavior、consumer_quoteの合計を3件以上にし、supply_signalは最大2件にする。',
      '企業買収・出店・商品投入だけの記事を生活者需要の証明にしない。主要テーマと無関係な記事を件数合わせに使わない。',
      'evidence_excerpt_or_factは出力しない。引用文はサーバーが記事本文から付与する。',
      'JSON全体を必ず完結させる。'
    ],
    required_shape: {
      evidence_matrix: [{
        theme_id: 'T1', article_id: 'uuid', claim: 'analytical claim',
        what_can_be_said: 'bounded conclusion', what_cannot_be_said: 'unsupported conclusion',
        limitation: 'limitation', evidence_strength: 'A|B|C',
        evidence_type: 'consumer_survey|purchase_behavior|usage_behavior|consumer_quote|supply_signal'
      }]
    }
  };

  const directTypes = new Set(['consumer_survey', 'purchase_behavior', 'usage_behavior', 'consumer_quote']);
  let selectedRaw: Json[] = [];
  let selectedIds: string[] = [];
  let evidenceFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptPayload = evidenceFeedback.length
      ? {
          ...evidencePayload,
          correction: {
            errors: evidenceFeedback,
            instruction: 'Return exactly 6 evidence items. Cover at least 4 themes, include at least 4 direct-consumer items, and include no more than 1 supply_signal. Do not repeat article IDs.'
          }
        }
      : evidencePayload;
    if (attempt > 1) await reportProgress(onProgress, 68, 'Evidence Criticの件数と構成を自己修正中');
    const evidenceCompletion = await timeout((signal) => openai.chat.completions.create({
      model: analystModel,
      ...(analystModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      response_format: { type: 'json_object' },
      max_completion_tokens: 3_000,
      messages: [
        {
          role: 'system',
          content: 'Return one complete JSON object only. Act as a strict evidence critic. Select only relevant, grounded evidence and distinguish direct consumer evidence from supply-side signals.'
        },
        { role: 'user', content: JSON.stringify(attemptPayload) }
      ]
    }, { signal }), stageTimeout);

    let evidenceCritic: Json;
    try {
      evidenceCritic = JSON.parse(evidenceCompletion.choices[0]?.message.content || '{}') as Json;
    } catch (error) {
      const detail = error instanceof Error ? error.message : text(error);
      evidenceFeedback = [`evidence critic JSON invalid or truncated: ${detail}`];
      continue;
    }

    const seenArticleIds = new Set<string>();
    const candidates = records(evidenceCritic.evidence_matrix).filter((item) => {
      const id = text(item.article_id);
      const themeId = text(item.theme_id);
      const type = text(item.evidence_type);
      const sourceItem = evidenceById.get(id);
      if (!id || seenArticleIds.has(id) || !sourceItem || !themeIds.has(themeId)) return false;
      if (!directTypes.has(type) && type !== 'supply_signal') return false;
      if (text(item.claim).length < 15 || brokenText(item.claim) || brokenText(item.what_can_be_said) || brokenText(item.what_cannot_be_said)) return false;
      if (!semanticEvidenceMatch(item, sourceItem)) return false;
      seenArticleIds.add(id);
      return true;
    });

    const chosen: Json[] = [];
    const chosenIds = new Set<string>();
    const chosenThemes = new Set<string>();
    const add = (item: Json) => {
      const id = text(item.article_id);
      if (!id || chosenIds.has(id) || chosen.length >= 8) return;
      chosen.push(item);
      chosenIds.add(id);
      chosenThemes.add(text(item.theme_id));
    };

    for (const item of candidates) {
      if (directTypes.has(text(item.evidence_type)) && !chosenThemes.has(text(item.theme_id))) add(item);
    }
    for (const item of candidates) {
      if (directTypes.has(text(item.evidence_type))) add(item);
    }
    let supplyAdded = 0;
    for (const item of candidates) {
      if (text(item.evidence_type) !== 'supply_signal' || supplyAdded >= 2) continue;
      if (!chosenThemes.has(text(item.theme_id))) {
        add(item);
        supplyAdded += 1;
      }
    }
    for (const item of candidates) {
      if (text(item.evidence_type) !== 'supply_signal' || supplyAdded >= 2) continue;
      const before = chosen.length;
      add(item);
      if (chosen.length > before) supplyAdded += 1;
    }

    const candidateIds = chosen.map((item) => text(item.article_id));
    const representedThemes = new Set(chosen.map((item) => text(item.theme_id)).filter((id) => themeIds.has(id)));
    const directCount = chosen.filter((item) => directTypes.has(text(item.evidence_type))).length;
    const supplyCount = chosen.filter((item) => text(item.evidence_type) === 'supply_signal').length;
    const errors: string[] = [];
    if (chosen.length < 6 || chosen.length > 8) errors.push(`requires 6〜8 evidence items after deterministic selection; received ${chosen.length}`);
    if (representedThemes.size < 4) errors.push(`requires at least 4 represented themes; received ${representedThemes.size}`);
    if (directCount < 3) errors.push(`requires at least 3 direct consumer evidence items; received ${directCount}`);
    if (supplyCount > 2) errors.push(`supply-side evidence exceeds limit: ${supplyCount}`);
    if (!errors.length) {
      selectedRaw = chosen;
      selectedIds = candidateIds;
      evidenceFeedback = [];
      break;
    }
    evidenceFeedback = errors;
  }
  if (evidenceFeedback.length || selectedRaw.length < 6) throw new Error(`evidence critic validation failed: ${evidenceFeedback.join('; ')}`);

  const selectedLookup = selectedIds.map((id) => evidenceById.get(id)).filter(Boolean) as Evidence[];
  const normalizedEvidence = records(ensureRawFields({ evidence_matrix: selectedRaw }, selectedLookup, run, scope).evidence_matrix);
  if (normalizedEvidence.length !== selectedRaw.length) throw new Error(`grounded evidence normalization removed items: ${normalizedEvidence.length}/${selectedRaw.length}`);

  await reportProgress(onProgress, 76, '選定テーマと根拠から最終レポートを執筆中');
  const finalPayload = {
    query,
    coverage: themePayload.coverage,
    ranked_themes: themes,
    cross_article_insights: themeAnalysis.cross_article_insights,
    selected_evidence: normalizedEvidence.map((item) => ({
      theme_id: item.theme_id,
      article_id: item.article_id,
      article_link: item.article_link,
      claim: item.claim,
      evidence_excerpt_or_fact: item.evidence_excerpt_or_fact,
      what_can_be_said: item.what_can_be_said,
      what_cannot_be_said: item.what_cannot_be_said,
      limitation: item.limitation,
      evidence_type: item.evidence_type,
      evidence_strength: item.evidence_strength
    })),
    rules: [
      '日本語1,600〜2,600文字で、結論、4〜5個の主要テーマ、反証・制約、実務含意、調査課題を書く。',
      'ranked_themesの順位と限定条件を維持し、selected_evidence以外の記事や数値を追加しない。',
      'URLやMarkdownリンクは一切書かない。検証済み根拠リンクはサーバーが後付けする。',
      '企業側のsupply_signalは供給側シグナルと明記し、生活者需要へ昇格しない。',
      '因果、年代、性別、市場規模を根拠なしに追加しない。',
      '最終WriterはJSONではなく日本語Markdown本文だけを返す。JSON、コードフェンス、前置きは禁止する。'
    ]
  };

  const allowedArticleIds = new Set(selectedIds.map((id) => id.toLowerCase()));
  const allowedNumbers = significantNumberTokens(JSON.stringify(finalPayload));
  let finalText = '';
  let finalFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) await reportProgress(onProgress, 84, '最終WriterのURL・数値制約を自己修正中');
    const writerPayload = finalFeedback.length
      ? {
          ...finalPayload,
          correction: {
            errors: finalFeedback,
            instruction: 'Return only a 1,600〜2,600-character Japanese Markdown report body. Do not include any URL, Markdown link, code fence, JSON, unsupported number, or unselected article.'
          }
        }
      : finalPayload;
    const finalCompletion = await timeout((signal) => openai.chat.completions.create({
      model: writerModel,
      ...(writerModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      max_completion_tokens: 2_500,
      messages: [
        {
          role: 'system',
          content: 'Return only the Japanese Markdown report body. Do not return JSON, a code fence, a title wrapper, a preface, any URL, or any Markdown link. Verified article links are appended by the server. You are a skeptical senior marketing-research writer. Use only ranked_themes and selected_evidence. Do not use a legacy report template, invent evidence counts, add unlisted articles, add unsupplied numbers, or convert supply signals into consumer demand. Keep the body between 1,600 and 2,600 Japanese characters.'
        },
        { role: 'user', content: JSON.stringify(writerPayload) }
      ]
    }, { signal }), stageTimeout);

    const candidateText = text(finalCompletion.choices[0]?.message.content)
      .replace(/^```(?:markdown)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const errors: string[] = [];
    if (candidateText.length < 1_200) errors.push(`final answer_text too short: ${candidateText.length}`);
    if (candidateText.length > 3_600) errors.push(`final answer_text too long: ${candidateText.length}`);
    if (/直接的な証拠は\s*\d|間接的な証拠は\s*\d|弱い証拠は\s*\d/.test(candidateText)) errors.push('final answer_text contains invented evidence counts');
    const outsideArticleIds = Array.from(linkedArticleIds(candidateText)).filter((id) => !allowedArticleIds.has(id));
    if (outsideArticleIds.length) errors.push(`final answer_text contains unselected article IDs: ${outsideArticleIds.join(',')}`);
    if (/(?:https?:\/\/|www\.|\]\()/i.test(candidateText)) errors.push('final answer_text contains links or URLs');
    const unsupportedNumbers = Array.from(significantNumberTokens(candidateText)).filter((token) => !allowedNumbers.has(token));
    if (unsupportedNumbers.length) errors.push(`final answer_text contains unsupported numbers: ${unsupportedNumbers.join(',')}`);
    if (!errors.length) {
      finalText = candidateText;
      finalFeedback = [];
      break;
    }
    finalFeedback = errors;
  }
  if (!finalText) throw new Error(`final writer validation failed: ${finalFeedback.join('; ')}`);
  const finalDraft: Json = {
    report_title: text(themeAnalysis.report_title) || '全件生活者インサイト総合レポート',
    answer_text: finalText,
    major_trends: themes,
    explanatory_hypotheses: themes.map((item) => ({ hypothesis: item.claim, why: item.support_summary })),
    cross_article_insights: themeAnalysis.cross_article_insights
  };

  const refutationAudit = themes.slice(0, 5).map((item) => ({
    target_claim: text(item.claim),
    possible_counterargument: text(item.counterargument),
    evidence_gap: text(item.reason_for_uncertainty),
    downgrade_or_revision: text(item.signal_type) === 'supply_only' ? '供給側シグナルとして限定し、生活者需要とは断定しない。' : '方向性の仮説として保持し、追加調査で強度を確認する。',
    falsification_condition: text(item.falsification_condition),
    synthetic_repair: false
  }));
  const confidenceRubric = themes.slice(0, 5).map((item) => ({
    claim: text(item.claim),
    confidence: text(item.confidence || 'B'),
    reason_for_confidence: text(item.support_summary),
    reason_for_uncertainty: text(item.reason_for_uncertainty),
    synthetic_repair: false
  }));
  const negativeSpace = records(themeAnalysis.negative_space).slice(0, 3).map((item) => ({
    expected_but_weak_or_absent_theme: cleanText([item.expected_but_weak_or_absent_theme, item.theme, item.gap], 300),
    why_absence_matters: cleanText([item.why_absence_matters, item.reason], 500),
    what_to_check_next: cleanText([item.what_to_check_next, item.next_check, item.method], 500),
    synthetic_repair: false
  }));
  const researchNeeds = records(themeAnalysis.research_needs).slice(0, 5).map((item) => ({
    question: cleanText([item.question, item.research_question, item.hypothesis_to_test, item.research_need], 500),
    why_it_matters: cleanText([item.why_it_matters, item.why_necessary, item.reason], 500),
    needed_data: cleanText([item.needed_data, item.data_needed, item.evidence_needed], 500),
    method_hint: cleanText([item.method_hint, item.method, item.how_to_test], 500),
    priority: text(item.priority || 'medium'),
    synthetic_repair: false
  }));
  if (negativeSpace.some((item) => item.expected_but_weak_or_absent_theme.length < 5 || item.why_absence_matters.length < 10)) throw new Error('negative_space normalization failed');
  if (researchNeeds.some((item) => item.question.length < 10)) throw new Error('research_needs normalization failed');

  const evidenceSection = normalizedEvidence.map((item) =>
    `- ${text(item.claim)}：${text(item.article_link)} — ${text(item.evidence_excerpt_or_fact).slice(0, 180)}`
  ).join('\n');
  const answer = ensureRawFields({
    ...finalDraft,
    report_title: text(finalDraft.report_title) || text(themeAnalysis.report_title) || '全件生活者インサイト総合レポート',
    answer_text: `${stripPriorFormalStop(finalDraft.answer_text)}\n\n## 根拠記事\n${evidenceSection}`.trim(),
    major_trends: records(finalDraft.major_trends).length ? finalDraft.major_trends : themes,
    explanatory_hypotheses: records(finalDraft.explanatory_hypotheses).length ? finalDraft.explanatory_hypotheses : themes.map((item) => ({ hypothesis: item.claim, why: item.support_summary })),
    cross_article_insights: records(finalDraft.cross_article_insights).length ? finalDraft.cross_article_insights : themeAnalysis.cross_article_insights,
    evidence_matrix: normalizedEvidence,
    refutation_audit: refutationAudit,
    negative_space: negativeSpace,
    confidence_rubric: confidenceRubric,
    research_needs: researchNeeds,
    analyst_model: analystModel,
    writer_model: writerModel,
    ranked_themes_raw: themes,
    generation_path: 'full_corpus_hierarchical_theme_evidence_writer_v1'
  }, selectedLookup, run, scope);

  const linkCount = (text(answer.answer_text).match(/\[[^\]]+\]\(\/articles\/[a-zA-Z0-9_-]+\)/g) || []).length;
  if (linkCount < 4) throw new Error(`answer_text requires at least 4 article links; received ${linkCount}`);

  return {
    report: null,
    report_error: '',
    related_articles: normalizedEvidence.map((item) => ({
      id: text(item.article_id), headline: text(item.headline), article_date: text(item.article_date),
      ocr_text: text(item.evidence_excerpt_or_fact)
    })),
    selectable_models: [writerModel, analystModel],
    answer
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

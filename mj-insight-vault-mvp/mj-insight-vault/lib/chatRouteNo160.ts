import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { MJ_REPORT_SYSTEM_PROMPT } from '@/lib/reportPrompt';
import { fetchAllWideArticles, type WideArticle } from '@/lib/wideArticleRetrieval';
import { runChatAnalysis as legacyRunChatAnalysis } from '@/lib/chatRouteCore';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';
import { buildMonthlyRollupContext } from '@/lib/monthlyRollupContext';
import { rankArticlesHybrid } from '@/lib/articleSearch';

const ALL_WORDS = /全期間|全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/i;
const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const FINAL_TIMEOUT_MS = 85000;
const FALLBACK_TIMEOUT_MS = 45000;

type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type Turn = { role: 'user' | 'assistant'; content: string };
type MonthlyContext = Awaited<ReturnType<typeof buildMonthlyRollupContext>>;
type ChatResult = { report: unknown; report_error: string; related_articles: WideArticle[]; selectable_models: string[]; answer: Record<string, unknown> };

function text(value: unknown) { return value === undefined || value === null ? '' : String(value).trim(); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function wantsWide(body: Record<string, unknown>) { return text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query)); }
function isBroadAllQuery(query: string) { return ALL_WORDS.test(query) || /全期間|全体|全件|全記事|全データ|すべて|全部/.test(query); }
function models() { return Array.from(new Set([TEXT_MODEL, ...(process.env.OPENAI_CHAT_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean), ...MODELS].filter(Boolean))); }
function chooseModel(value: unknown) { const m = text(value); return models().includes(m) ? m : TEXT_MODEL; }
function fallbackModel(primary: string) { const configured = text(process.env.OPENAI_FINAL_FALLBACK_MODEL || 'gpt-5-mini'); if (configured && configured !== primary && models().includes(configured)) return configured; return primary === 'gpt-5-mini' ? 'gpt-4.1-mini' : 'gpt-5-mini'; }
function articleLink(article: WideArticle) { return `[${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}](/articles/${article.id})`; }
function excerpt(article: WideArticle, length: number) { return (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, length); }
function monthKey(article: WideArticle) { const date = text(article.article_date); const iso = date.match(/^(\d{4})[-/](\d{1,2})/); if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}`; const jp = date.match(/^(\d{4})年\s*(\d{1,2})月/); if (jp) return `${jp[1]}-${jp[2].padStart(2, '0')}`; return 'undated'; }

function turns(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: text(item.content).slice(0, 6000) }))
    .filter((item) => item.content)
    .slice(-8) as Turn[];
}

async function progress(onProgress: ProgressReporter | undefined, progressValue: number, stage: string) { try { await onProgress?.({ progress: progressValue, stage }); } catch {} }
function queryTerms(query: string) { return Array.from(new Set(query.replace(ALL_WORDS, ' ').replace(/[^\p{Letter}\p{Number}ぁ-んァ-ヶ一-龠々ー]+/gu, ' ').split(/\s+/).map((term) => term.trim()).filter((term) => term.length >= 2).slice(0, 24))); }

function lexicalSelect(query: string, articles: WideArticle[], max: number) {
  const terms = queryTerms(query);
  if (!terms.length) return articles.slice(0, max);
  return articles.map((article, index) => {
    const headline = `${article.headline || ''} ${article.article_date || ''}`.toLowerCase();
    const body = (article.ocr_text || '').slice(0, 5000).toLowerCase();
    const score = terms.reduce((total, term) => {
      const t = term.toLowerCase();
      return total + (headline.includes(t) ? 8 : 0) + (body.includes(t) ? 3 : 0);
    }, 0) + Math.max(0, 1 - index / Math.max(articles.length, 1));
    return { article, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.article).slice(0, max);
}

async function hybridSelect(query: string, articles: WideArticle[], max: number) {
  if (!queryTerms(query).length) return articles.slice(0, max);
  try {
    const ranked = await rankArticlesHybrid(articles, query);
    const rows = ranked.articles as WideArticle[];
    if (rows.length) return rows.slice(0, max);
  } catch {}
  return lexicalSelect(query, articles, max);
}

function groupByMonth(articles: WideArticle[]) {
  const groups = new Map<string, WideArticle[]>();
  for (const article of articles) {
    const key = monthKey(article);
    groups.set(key, [...(groups.get(key) || []), article]);
  }
  return groups;
}

function monthSortKey(month: string) {
  return month === 'undated' ? '9999-99' : month;
}

function computeMonthQuotas(articles: WideArticle[], max: number) {
  const groups = groupByMonth(articles);
  const months = Array.from(groups.keys()).sort((a, b) => monthSortKey(a).localeCompare(monthSortKey(b)));
  const total = articles.length || 1;
  const quota = new Map<string, number>();

  for (const month of months) {
    const count = groups.get(month)?.length || 0;
    if (!count) continue;
    const base = count <= 2 ? count : Math.min(count, max >= 70 ? 4 : 2);
    quota.set(month, base);
  }

  let used = Array.from(quota.values()).reduce((sum, value) => sum + value, 0);
  const remainders = months.map((month) => {
    const count = groups.get(month)?.length || 0;
    const exact = (count / total) * max;
    return { month, count, exact, remainder: exact - Math.floor(exact) };
  }).sort((a, b) => b.exact - a.exact || b.remainder - a.remainder);

  while (used < max) {
    let changed = false;
    for (const item of remainders) {
      if (used >= max) break;
      const current = quota.get(item.month) || 0;
      if (current >= item.count) continue;
      quota.set(item.month, current + 1);
      used += 1;
      changed = true;
    }
    if (!changed) break;
  }

  return quota;
}

async function selectEvidenceArticles(query: string, articles: WideArticle[], context: MonthlyContext | null, max: number) {
  if (!context?.has_rollups) return hybridSelect(query, articles, max);

  const broad = isBroadAllQuery(query);
  const byId = new Map(articles.map((article) => [article.id, article]));
  const preferredIds = [...context.evidence_article_ids, ...context.representative_article_ids];
  const selected: WideArticle[] = [];
  const used = new Set<string>();

  function add(article: WideArticle | undefined) {
    if (!article || used.has(article.id) || selected.length >= max) return false;
    selected.push(article);
    used.add(article.id);
    return true;
  }

  const ranked = await hybridSelect(query, articles, Math.max(180, max * 3));
  const rankedByMonth = groupByMonth(ranked);
  const articleByMonth = groupByMonth(articles);
  const quotas = computeMonthQuotas(articles, max);

  if (broad) {
    for (const [month, quota] of quotas.entries()) {
      const monthRanked = rankedByMonth.get(month) || [];
      const monthAll = articleByMonth.get(month) || [];
      for (const article of [...monthRanked, ...monthAll]) {
        if ((selected.filter((item) => monthKey(item) === month).length) >= quota) break;
        add(article);
      }
    }
  } else {
    for (const article of ranked) {
      add(article);
      if (selected.length >= Math.ceil(max * 0.45)) break;
    }
    for (const [month, quota] of quotas.entries()) {
      const already = selected.filter((item) => monthKey(item) === month).length;
      const target = Math.min(quota, Math.max(already, Math.ceil(quota * 0.55)));
      const candidates = [...(rankedByMonth.get(month) || []), ...(articleByMonth.get(month) || [])];
      for (const article of candidates) {
        if ((selected.filter((item) => monthKey(item) === month).length) >= target) break;
        add(article);
      }
    }
  }

  const coveredMonths = new Set(selected.map(monthKey));
  for (const id of preferredIds) {
    const article = byId.get(id);
    if (!article) continue;
    const m = monthKey(article);
    if (coveredMonths.has(m) && selected.length >= Math.ceil(max * 0.85)) continue;
    if (add(article)) coveredMonths.add(m);
    if (selected.length >= max) return selected;
  }

  for (const article of ranked) {
    add(article);
    if (selected.length >= max) return selected;
  }

  for (const article of lexicalSelect(query, articles, max)) add(article);
  return selected.slice(0, max);
}

function withAbortTimeout<T>(factory: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    factory(controller.signal)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function withProgressHeartbeat<T>(promise: Promise<T>, onProgress: ProgressReporter | undefined, options: { from: number; to: number; intervalMs: number; stage: string }) {
  if (!onProgress) return promise;
  let current = options.from;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    current = Math.min(options.to, current + 1);
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    void progress(onProgress, current, `${options.stage}（${elapsed}秒経過。長い工程ですが、ページ移動後も状態は保持されます）`);
  }, options.intervalMs);
  try { return await promise; } finally { clearInterval(timer); }
}

function buildArticleInput(articles: WideArticle[], textLimit: number) {
  return articles.map((article, index) => ({
    no: index + 1,
    article_id: article.id,
    headline: article.headline,
    article_date: article.article_date || '日付不明',
    article_link: articleLink(article),
    month_key: monthKey(article),
    text: (article.ocr_text || '').slice(0, textLimit)
  }));
}

function monthlyPromptMessage(context: MonthlyContext | null): Turn[] {
  if (!context?.has_rollups || !context.context_text) return [];
  return [{ role: 'user', content: ['【MONTHLY_ROLLUP_CONTEXT_PRIMARY】', '以下は全記事を月別に集約した中間レイヤーです。全体分析では、ここを一次情報として必ず横断してください。', '最終投入する個別記事は根拠確認・具体例用であり、分析母集団を個別記事数に限定してはいけません。', `rollup_count: ${context.rollup_count}`, `rollup_source_article_count: ${context.article_count}`, context.context_text].join('\n') }];
}

function buildEmergencyAnswer(query: string, base: Record<string, unknown>, finalArticles: WideArticle[], error: string) {
  const sourceCoverage = isRecord(base.source_coverage) ? base.source_coverage : {};
  const articleLines = finalArticles.slice(0, 16).map((article, index) => `${index + 1}. ${articleLink(article)}\n   ${excerpt(article, 180)}`).join('\n');
  return { ...base, report_title: '暫定レポート：最終生成がタイムアウトしました', answer_text: ['## 結論', '最終レポート生成がタイムアウトしたため、暫定出力です。全記事取得と月別rollup参照は完了していますが、深い統合分析は未完了です。', '', '## 状態', `- ユーザー指示: ${query}`, `- エラー: ${error}`, `- 取得記事数: ${text((sourceCoverage as Record<string, unknown>).article_count)}`, `- 根拠確認用記事: ${finalArticles.length}件`, '', '## 代表記事候補', articleLines || '代表記事候補なし', '', '## 根拠と限界', 'この出力はタイムアウト時の安全フォールバックです。通常レポートより浅いため、月別rollup生成状態を確認したうえで再分析してください。'].join('\n'), generation_warning: 'emergency_timeout_fallback', generation_error: error };
}

async function getMonthlyContext() { try { return await buildMonthlyRollupContext(); } catch { return null; } }

function buildQualityInstructions(provisional: boolean) {
  return {
    evidence_selection: 'Evidence articles are selected by balanced month-aware sampling plus hybrid semantic/lexical search. Do not treat selected articles as the full universe when monthly rollups exist.',
    must_separate: ['fact', 'inference', 'hypothesis', 'unsupported_or_research_needed'],
    must_include: ['evidence_matrix', 'refutation_audit', 'negative_space', 'confidence_rubric', 'research_needs'],
    overclaim_guard: 'Company or retailer action is only market-side signal. It becomes consumer-side evidence only when article facts show adoption, sales, usage, repeat, or consumer response.',
    coverage_wording: 'Do not write 直接該当 as if it were full-corpus coverage. Use 全件カバレッジ, 月別rollup対象記事数, and 根拠確認用記事数 separately.',
    if_provisional: provisional ? 'Mark as provisional and downgrade claims.' : 'Coverage is complete, but still grade evidence strength claim by claim.'
  };
}

async function runWide(body: Record<string, unknown>, onProgress?: ProgressReporter) {
  const query = text(body.query);
  if (!query) throw new Error('query is required');
  const selectedModel = chooseModel(body.model);
  const openai = getOpenAI();

  await progress(onProgress, 18, '全記事をページング取得中');
  const allArticles = await fetchAllWideArticles();
  await progress(onProgress, 30, `${allArticles.length}件の記事を取得`);

  await progress(onProgress, 42, '月別まとめレイヤーを確認中');
  const monthlyContext = await getMonthlyContext();
  const monthlyUsed = Boolean(monthlyContext?.has_rollups && monthlyContext.context_text);
  const coverageComplete = Boolean(monthlyContext?.coverage_complete);
  const finalLimit = monthlyUsed ? (selectedModel === 'gpt-5' ? 44 : 32) : selectedModel === 'gpt-5' ? 36 : 24;
  const finalArticles = await selectEvidenceArticles(query, allArticles, monthlyContext, finalLimit);
  const responseArticles = finalArticles;
  const rollupArticleCount = monthlyContext?.article_count || 0;
  const activeArticleCount = monthlyContext?.total_article_count || allArticles.length;
  const missingMonths = monthlyContext?.missing_months || [];
  const staleMonths = monthlyContext?.stale_months || [];
  const failedMonths = monthlyContext?.failed_months || [];
  const runningMonths = monthlyContext?.running_months || [];
  const provisional = !monthlyUsed || !coverageComplete;
  const evidenceMonthDistribution = finalArticles.reduce<Record<string, number>>((counts, article) => { const m = monthKey(article); counts[m] = (counts[m] || 0) + 1; return counts; }, {});

  const base = {
    target_scope: 'all', retrieval_mode: monthlyUsed ? 'monthly_rollup_plus_balanced_hybrid_evidence' : 'hybrid_wide_article_scan', model_used: selectedModel, requested_model: selectedModel,
    scan_enabled: true, scan_model: monthlyUsed ? 'monthly_rollups_plus_balanced_hybrid_search' : 'hybrid_lexical_semantic', scan_error: monthlyUsed ? '' : 'monthly_rollups_missing_or_not_ready; hybrid article selection used',
    article_count_scanned: allArticles.length, article_count_for_report: finalArticles.length, related_article_count: allArticles.length, selected_article_ids: finalArticles.map((article) => article.id),
    monthly_rollup_used: monthlyUsed, monthly_rollup_count: monthlyContext?.rollup_count || 0, monthly_rollup_source_article_count: rollupArticleCount, monthly_rollup_coverage_complete: coverageComplete,
    monthly_rollup_ready_months: monthlyContext?.ready_months || [], monthly_rollup_missing_months: missingMonths, monthly_rollup_stale_months: staleMonths, monthly_rollup_failed_months: failedMonths, monthly_rollup_running_months: runningMonths,
    analysis_is_provisional: provisional,
    source_coverage: {
      article_count: allArticles.length, active_article_count: activeArticleCount, scanned_article_count: allArticles.length, final_article_count: finalArticles.length,
      monthly_rollup_used: monthlyUsed, monthly_rollup_count: monthlyContext?.rollup_count || 0, monthly_rollup_source_article_count: rollupArticleCount, monthly_rollup_total_article_count: activeArticleCount, monthly_rollup_article_month_count: monthlyContext?.article_month_count || 0,
      monthly_rollup_coverage_complete: coverageComplete, monthly_rollup_status_counts: monthlyContext?.status_counts || {}, monthly_rollup_ready_months: monthlyContext?.ready_months || [], monthly_rollup_missing_months: missingMonths, monthly_rollup_stale_months: staleMonths, monthly_rollup_failed_months: failedMonths, monthly_rollup_running_months: runningMonths,
      evidence_selection_mode: 'balanced_month_quota_plus_hybrid_semantic_lexical', evidence_month_distribution: evidenceMonthDistribution, analysis_is_provisional: provisional,
      coverage_note: monthlyUsed ? `全記事${allArticles.length}件をページング取得し、ready月別rollup ${monthlyContext?.rollup_count}ヶ月・${rollupArticleCount}記事分を一次入力として横断。個別記事${finalArticles.length}件は月別分布を補正したうえでハイブリッド検索と月別代表根拠から選抜した根拠確認用。これは直接該当率ではありません。160件制限は使用していません。${coverageComplete ? '月別rollupは全記事あり月をカバーしています。' : `未作成${missingMonths.length}ヶ月、要更新${staleMonths.length}ヶ月、失敗${failedMonths.length}ヶ月、生成中${runningMonths.length}ヶ月があるため暫定分析です。`}` : `全記事${allArticles.length}件をページング取得。ただし使用可能な月別rollupがないため、個別記事${finalArticles.length}件のハイブリッド検索による暫定分析。160件制限は使用していません。`
    },
    coverage_diagnosis: { monthly_rollup_used: monthlyUsed, monthly_rollup_coverage_complete: coverageComplete, analysis_is_provisional: provisional, ready_month_count: monthlyContext?.ready_months.length || 0, article_month_count: monthlyContext?.article_month_count || 0, missing_month_count: missingMonths.length, stale_month_count: staleMonths.length, failed_month_count: failedMonths.length, running_month_count: runningMonths.length, evidence_selection_mode: 'balanced_month_quota_plus_hybrid_semantic_lexical', guidance: provisional ? '月別rollupが未作成・要更新・失敗・生成中の月を含むため、全体分析は暫定です。/rollupsで必要な月だけ生成してください。' : '月別rollupが全記事あり月をカバーしているため、全体分析の一次入力として使用できます。' },
    article_lookup: finalArticles.map((article) => ({ article_id: article.id, headline: article.headline || '無題の記事', article_date: article.article_date || '日付不明', article_link: articleLink(article), article_url: `/articles/${article.id}`, month_key: monthKey(article) }))
  };

  const compactInput = buildArticleInput(finalArticles, monthlyUsed ? 320 : 720);
  const conversation = [...turns(body.conversation), ...monthlyPromptMessage(monthlyContext)];
  const system = `${MJ_REPORT_SYSTEM_PROMPT}\nUse article_link when citing evidence. Include coverage_diagnosis, evidence_matrix, refutation_audit, confidence_rubric, negative_space and research_needs. If monthly rollup context is present, treat it as the primary full-corpus analysis layer and individual articles as evidence examples. Do not use 直接該当 to describe coverage; separate full-corpus coverage from evidence articles.`;
  const provisionalInstruction = provisional ? '月別rollupに未作成・要更新・失敗・生成中の月がある場合、このレポートは「暫定分析」と明示し、coverage_diagnosisに不足月の状態を残してください。' : '月別rollupは全記事あり月をカバーしています。個別記事数ではなく月別rollupを全体分析の一次入力として扱ってください。「直接該当」ではなく「根拠確認用記事数」と表記してください。';
  const qualityInstructions = buildQualityInstructions(provisional);
  let parsed: Record<string, unknown> = {};
  let generationWarning = '';

  if (!openai) {
    await progress(onProgress, 88, 'OPENAI_API_KEY未設定の診断レポートを作成中');
    generationWarning = 'OPENAI_API_KEY missing';
    parsed = { report_title: '診断レポート：OpenAI APIキー未設定', answer_text: ['## 結論', 'OPENAI_API_KEY が未設定のため、AIによる本文生成は実行できませんでした。ただし、全記事取得・月別rollup状態確認・根拠候補抽出までは完了しています。', '', '## 状態', `- 取得記事数: ${allArticles.length}`, `- 月別rollup使用: ${monthlyUsed ? 'あり' : 'なし'}`, `- 根拠確認用記事: ${finalArticles.length}件`, '', '## 次に必要な対応', 'Vercelまたは実行環境に OPENAI_API_KEY を設定してください。設定後、同じ指示で再実行してください。'].join('\n') };
  } else {
    await progress(onProgress, 62, monthlyUsed ? '月別まとめと根拠記事を最終入力に準備中' : `根拠候補${finalArticles.length}件を最終入力に準備中`);
    try {
      await progress(onProgress, 68, monthlyUsed ? `${selectedModel}で月別まとめを統合中` : `${selectedModel}で最終レポートを生成中。遅い場合は自動で軽量生成に切り替えます`);
      const completion = await withProgressHeartbeat(withAbortTimeout((signal) => openai.chat.completions.create({ model: selectedModel, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...conversation, { role: 'user', content: JSON.stringify({ query, coverage: base.source_coverage, coverage_diagnosis: base.coverage_diagnosis, monthly_rollup_context_used: monthlyUsed, analysis_instruction: provisionalInstruction, quality_instructions: qualityInstructions, articles_for_evidence: compactInput }) }] }, { signal }), FINAL_TIMEOUT_MS, 'final report generation'), onProgress, { from: 68, to: 86, intervalMs: 10000, stage: monthlyUsed ? `${selectedModel}で月別まとめを統合中` : `${selectedModel}で最終レポートを生成中` });
      parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Record<string, unknown>;
    } catch (primaryError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : 'final report generation failed';
      const fbModel = fallbackModel(selectedModel);
      generationWarning = `primary_failed: ${primaryMessage}`;
      try {
        await progress(onProgress, 78, `${fbModel}で軽量統合レポートを生成中`);
        const fallbackInput = buildArticleInput(finalArticles.slice(0, Math.min(18, finalArticles.length)), 360);
        const completion = await withProgressHeartbeat(withAbortTimeout((signal) => openai.chat.completions.create({ model: fbModel, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: `${MJ_REPORT_SYSTEM_PROMPT}\nReturn compact JSON. Use monthly rollups as full-corpus context when present. Use article_link for evidence. Separate full-corpus coverage from evidence article count.` }, ...conversation, { role: 'user', content: JSON.stringify({ query, coverage: base.source_coverage, coverage_diagnosis: base.coverage_diagnosis, primary_error: primaryMessage, monthly_rollup_context_used: monthlyUsed, analysis_instruction: provisionalInstruction, quality_instructions: qualityInstructions, articles_for_evidence: fallbackInput }) }] }, { signal }), FALLBACK_TIMEOUT_MS, 'fallback report generation'), onProgress, { from: 78, to: 90, intervalMs: 10000, stage: `${fbModel}で軽量統合レポートを生成中` });
        parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Record<string, unknown>;
        generationWarning = `fallback_model_used: ${fbModel}; ${generationWarning}`;
      } catch (fallbackError) {
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'fallback report generation failed';
        parsed = buildEmergencyAnswer(query, base, finalArticles, `${generationWarning}; fallback_failed: ${fallbackMessage}`);
        generationWarning = `emergency_fallback_used: ${generationWarning}; fallback_failed: ${fallbackMessage}`;
      }
    }
  }

  const answerText = typeof parsed.answer_text === 'string' ? parsed.answer_text : JSON.stringify(parsed);
  const answer = { ...base, quality_instructions: qualityInstructions, ...parsed, answer_text: answerText, generation_warning: generationWarning };
  const enhanced = enhanceChatAnalysisResult({ report: null, report_error: '', related_articles: responseArticles, selectable_models: models(), answer }) as ChatResult;
  const enhancedAnswer = isRecord(enhanced.answer) ? enhanced.answer : answer;
  let report = null;
  let report_error = '';

  await progress(onProgress, 94, '分析履歴を保存中');
  try {
    const saved = await supabaseAdmin.from('chat_reports').insert({ user_query: query, answer_text: text(enhancedAnswer.answer_text), answer_json: enhancedAnswer, related_article_ids: finalArticles.map((article) => article.id) }).select('*').single();
    if (saved.error) throw saved.error;
    report = saved.data;
  } catch (error) { report_error = error instanceof Error ? error.message : 'chat_reports insert failed'; }

  await progress(onProgress, 100, report_error ? 'レポート生成完了。履歴保存に警告あり' : 'レポート生成完了');
  return { ...enhanced, report, report_error, answer: enhancedAnswer };
}

async function persistEnhancedResult(result: unknown) {
  if (!isRecord(result) || !isRecord(result.answer) || !isRecord(result.report)) return;
  const reportId = text(result.report.id);
  if (!reportId) return;
  await supabaseAdmin.from('chat_reports').update({ answer_text: text(result.answer.answer_text) || JSON.stringify(result.answer), answer_json: result.answer }).eq('id', reportId);
}

export async function runChatAnalysis(body: Record<string, unknown>, onProgress?: ProgressReporter) {
  const raw = wantsWide(body) ? await runWide(body, onProgress) : await legacyRunChatAnalysis(body, onProgress);
  const enhanced = enhanceChatAnalysisResult(raw);
  await persistEnhancedResult(enhanced);
  return enhanced;
}

export async function POST(req: NextRequest) {
  try { requireAppPassword(req); return Response.json(await runChatAnalysis(await req.json())); }
  catch (error) { return jsonError(error); }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { MJ_REPORT_SYSTEM_PROMPT } from '@/lib/reportPrompt';
import { fetchAllWideArticles, type WideArticle } from '@/lib/wideArticleRetrieval';
import { runChatAnalysis as legacyRunChatAnalysis } from '@/lib/chatRouteCore';
import { enhanceChatAnalysisResult } from '@/lib/chatAnalysisQualityGate';

const ALL_WORDS = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/i;
const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const FINAL_TIMEOUT_MS = 105000;
const FALLBACK_TIMEOUT_MS = 65000;

type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type Turn = { role: 'user' | 'assistant'; content: string };

type ChatResult = {
  report: unknown;
  report_error: string;
  related_articles: WideArticle[];
  selectable_models: string[];
  answer: Record<string, unknown>;
};

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function wantsWide(body: Record<string, unknown>) {
  return text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query));
}

function models() {
  return Array.from(new Set([
    TEXT_MODEL,
    ...(process.env.OPENAI_CHAT_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean),
    ...MODELS
  ].filter(Boolean)));
}

function chooseModel(value: unknown) {
  const m = text(value);
  return models().includes(m) ? m : TEXT_MODEL;
}

function fallbackModel(primary: string) {
  const configured = text(process.env.OPENAI_FINAL_FALLBACK_MODEL || 'gpt-5-mini');
  if (configured && configured !== primary && models().includes(configured)) return configured;
  return primary === 'gpt-5-mini' ? 'gpt-4.1-mini' : 'gpt-5-mini';
}

function articleLink(article: WideArticle) {
  return `[${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}](/articles/${article.id})`;
}

function excerpt(article: WideArticle, length: number) {
  return (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, length);
}

function turns(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: text(item.content).slice(0, 6000) }))
    .filter((item) => item.content)
    .slice(-8) as Turn[];
}

async function progress(onProgress: ProgressReporter | undefined, progressValue: number, stage: string) {
  try { await onProgress?.({ progress: progressValue, stage }); } catch {}
}

function queryTerms(query: string) {
  return Array.from(new Set(query
    .replace(ALL_WORDS, ' ')
    .replace(/[^\p{Letter}\p{Number}ぁ-んァ-ヶ一-龠々ー]+/gu, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 24)));
}

function lexicalSelect(query: string, articles: WideArticle[], max: number) {
  const terms = queryTerms(query);
  if (!terms.length) return articles.slice(0, max);
  return articles
    .map((article, index) => {
      const headline = `${article.headline || ''} ${article.article_date || ''}`.toLowerCase();
      const body = (article.ocr_text || '').slice(0, 5000).toLowerCase();
      const score = terms.reduce((total, term) => {
        const t = term.toLowerCase();
        return total + (headline.includes(t) ? 8 : 0) + (body.includes(t) ? 3 : 0);
      }, 0) + Math.max(0, 1 - index / Math.max(articles.length, 1));
      return { article, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.article)
    .slice(0, max);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }).catch((error) => { clearTimeout(timer); reject(error); });
  });
}

function buildArticleInput(articles: WideArticle[], textLimit: number) {
  return articles.map((article, index) => ({
    no: index + 1,
    article_id: article.id,
    headline: article.headline,
    article_date: article.article_date || '日付不明',
    article_link: articleLink(article),
    text: (article.ocr_text || '').slice(0, textLimit)
  }));
}

function buildEmergencyAnswer(query: string, base: Record<string, unknown>, finalArticles: WideArticle[], error: string) {
  const sourceCoverage = isRecord(base.source_coverage) ? base.source_coverage : {};
  const articleLines = finalArticles.slice(0, 16).map((article, index) => `${index + 1}. ${articleLink(article)}\n   ${excerpt(article, 180)}`).join('\n');
  return {
    ...base,
    report_title: '暫定レポート：最終生成がタイムアウトしました',
    answer_text: [
      '## 結論',
      '最終レポート生成がタイムアウトしたため、選抜記事に基づく暫定出力です。全記事取得と記事選抜は完了していますが、深い統合分析は未完了です。',
      '',
      '## 状態',
      `- ユーザー指示: ${query}`,
      `- エラー: ${error}`,
      `- 取得記事数: ${text(sourceCoverage.article_count)}`,
      `- 最終投入候補: ${finalArticles.length}件`,
      '',
      '## 代表記事候補',
      articleLines || '代表記事候補なし',
      '',
      '## 根拠と限界',
      'この出力はタイムアウト時の安全フォールバックです。通常レポートより浅いため、月別rollup生成後の再分析を推奨します。'
    ].join('\n'),
    generation_warning: 'emergency_timeout_fallback',
    generation_error: error
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

  const finalLimit = selectedModel === 'gpt-5' ? 32 : 24;
  const finalArticles = lexicalSelect(query, allArticles, finalLimit);
  const base = {
    target_scope: 'all',
    retrieval_mode: 'wide_all_data_scan',
    model_used: selectedModel,
    requested_model: selectedModel,
    scan_enabled: true,
    scan_model: 'lexical_fallback',
    scan_error: '',
    article_count_scanned: allArticles.length,
    article_count_for_report: finalArticles.length,
    related_article_count: allArticles.length,
    selected_article_ids: finalArticles.map((article) => article.id),
    source_coverage: {
      article_count: allArticles.length,
      scanned_article_count: allArticles.length,
      final_article_count: finalArticles.length,
      coverage_note: `全記事${allArticles.length}件をページング取得し、最終分析には${finalArticles.length}件を選抜投入。160件制限は使用していません。`
    },
    article_lookup: finalArticles.map((article) => ({
      article_id: article.id,
      headline: article.headline || '無題の記事',
      article_date: article.article_date || '日付不明',
      article_link: articleLink(article),
      article_url: `/articles/${article.id}`
    }))
  };

  if (!openai) {
    return enhanceChatAnalysisResult({
      report: null,
      report_error: 'OPENAI_API_KEY missing',
      related_articles: allArticles,
      selectable_models: models(),
      answer: { ...base, report_title: '該当記事一覧', answer_text: `OPENAI_API_KEYが未設定のため、全記事${allArticles.length}件の取得情報のみ返します。` }
    }) as ChatResult;
  }

  await progress(onProgress, 62, `最終レポート入力を${finalArticles.length}件に圧縮中`);
  const compactInput = buildArticleInput(finalArticles, 900);
  const system = `${MJ_REPORT_SYSTEM_PROMPT}\nUse article_link when citing evidence. Include coverage_diagnosis, evidence_matrix, refutation_audit and research_needs. Keep output useful but compact.`;
  let parsed: Record<string, unknown> = {};
  let generationWarning = '';

  try {
    await progress(onProgress, 68, `${selectedModel}で最終レポートを生成中。遅い場合は自動で軽量生成に切り替えます`);
    const completion = await withTimeout(openai.chat.completions.create({
      model: selectedModel,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        ...turns(body.conversation),
        { role: 'user', content: JSON.stringify({ query, coverage: base.source_coverage, articles: compactInput }) }
      ]
    } as any), FINAL_TIMEOUT_MS, 'final report generation');
    parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Record<string, unknown>;
  } catch (primaryError) {
    const primaryMessage = primaryError instanceof Error ? primaryError.message : 'final report generation failed';
    const fbModel = fallbackModel(selectedModel);
    generationWarning = `primary_failed: ${primaryMessage}`;
    try {
      await progress(onProgress, 78, `${fbModel}で軽量レポートを生成中`);
      const fallbackInput = buildArticleInput(finalArticles.slice(0, Math.min(18, finalArticles.length)), 650);
      const completion = await withTimeout(openai.chat.completions.create({
        model: fbModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${MJ_REPORT_SYSTEM_PROMPT}\nReturn compact JSON. Use article_link for evidence. State that fallback generation was used.` },
          ...turns(body.conversation),
          { role: 'user', content: JSON.stringify({ query, coverage: base.source_coverage, primary_error: primaryMessage, articles: fallbackInput }) }
        ]
      } as any), FALLBACK_TIMEOUT_MS, 'fallback report generation');
      parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Record<string, unknown>;
      generationWarning = `fallback_model_used: ${fbModel}; ${generationWarning}`;
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'fallback report generation failed';
      parsed = buildEmergencyAnswer(query, base, finalArticles, `${generationWarning}; fallback_failed: ${fallbackMessage}`);
      generationWarning = `emergency_fallback_used: ${generationWarning}; fallback_failed: ${fallbackMessage}`;
    }
  }

  const answerText = typeof parsed.answer_text === 'string' ? parsed.answer_text : JSON.stringify(parsed);
  const answer = { ...base, ...parsed, answer_text: answerText, generation_warning: generationWarning };
  const enhanced = enhanceChatAnalysisResult({ report: null, report_error: '', related_articles: allArticles, selectable_models: models(), answer }) as ChatResult;
  const enhancedAnswer = isRecord(enhanced.answer) ? enhanced.answer : answer;
  let report = null;
  let report_error = '';

  await progress(onProgress, 94, '分析履歴を保存中');
  try {
    const saved = await supabaseAdmin.from('chat_reports').insert({
      user_query: query,
      answer_text: text(enhancedAnswer.answer_text),
      answer_json: enhancedAnswer,
      related_article_ids: allArticles.map((article) => article.id)
    }).select('*').single();
    if (saved.error) throw saved.error;
    report = saved.data;
  } catch (error) {
    report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
  }

  await progress(onProgress, 100, report_error ? 'レポート生成完了。履歴保存に警告あり' : 'レポート生成完了');
  return { ...enhanced, report, report_error, answer: enhancedAnswer };
}

async function persistEnhancedResult(result: unknown) {
  if (!isRecord(result) || !isRecord(result.answer) || !isRecord(result.report)) return;
  const reportId = text(result.report.id);
  if (!reportId) return;
  await supabaseAdmin.from('chat_reports').update({
    answer_text: text(result.answer.answer_text) || JSON.stringify(result.answer),
    answer_json: result.answer
  }).eq('id', reportId);
}

export async function runChatAnalysis(body: Record<string, unknown>, onProgress?: ProgressReporter) {
  const raw = wantsWide(body) ? await runWide(body, onProgress) : await legacyRunChatAnalysis(body, onProgress);
  const enhanced = enhanceChatAnalysisResult(raw);
  await persistEnhancedResult(enhanced);
  return enhanced;
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await runChatAnalysis(await req.json()));
  } catch (error) {
    return jsonError(error);
  }
}

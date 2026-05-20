import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { MJ_REPORT_SYSTEM_PROMPT } from '@/lib/reportPrompt';
import { fetchAllWideArticles, type WideArticle } from '@/lib/wideArticleRetrieval';
import { runChatAnalysis as legacyRunChatAnalysis } from '@/lib/chatRouteCore';

const ALL_WORDS = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/i;
const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];

type ProgressReporter = (update: { progress: number; stage: string }) => void | Promise<void>;
type Turn = { role: 'user' | 'assistant'; content: string };

function text(value: unknown) { return value === undefined || value === null ? '' : String(value).trim(); }
function wantsWide(body: Record<string, unknown>) { return text(body.target_scope || 'all') === 'all' || ALL_WORDS.test(text(body.query)); }
function models() { return Array.from(new Set([TEXT_MODEL, ...(process.env.OPENAI_CHAT_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean), ...MODELS].filter(Boolean))); }
function model(value: unknown) { const m = text(value); return models().includes(m) ? m : TEXT_MODEL; }
function scanModel() { const m = text(process.env.OPENAI_SCAN_MODEL || 'gpt-5-nano'); return models().includes(m) ? m : 'gpt-5-nano'; }
function articleLink(article: WideArticle) { return `[${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}](/articles/${article.id})`; }
function excerpt(article: WideArticle, n: number) { return (article.ocr_text || '').replace(/\s+/g, ' ').slice(0, n); }
function turns(value: unknown): Turn[] { return Array.isArray(value) ? value.map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {}).map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: text(item.content).slice(0, 6000) })).filter((item) => item.content).slice(-8) as Turn[] : []; }
async function progress(onProgress: ProgressReporter | undefined, p: number, stage: string) { try { await onProgress?.({ progress: p, stage }); } catch {} }
function scanTextLimit(count: number) { if (count > 700) return 180; if (count > 500) return 240; if (count > 300) return 320; if (count > 180) return 420; return 550; }
function finalTextLimit(count: number) { if (count > 40) return 1800; if (count > 30) return 2200; return 2600; }
function selectedCount(selectedModel: string) { return selectedModel === 'gpt-5' ? 48 : 32; }
function uniqueIds(value: unknown) { return Array.isArray(value) ? Array.from(new Set(value.map((x) => text(x)).filter(Boolean))) : []; }
function selectByIds(articles: WideArticle[], ids: string[], max: number) { const map = new Map(articles.map((a) => [a.id, a])); const picked = ids.map((id) => map.get(id)).filter(Boolean) as WideArticle[]; const used = new Set(picked.map((a) => a.id)); return [...picked, ...articles.filter((a) => !used.has(a.id))].slice(0, max); }

async function selectArticles(query: string, articles: WideArticle[], selectedModel: string, onProgress?: ProgressReporter) {
  const openai = getOpenAI();
  const max = selectedCount(selectedModel);
  if (!openai || articles.length <= max) return { finalArticles: articles.slice(0, max), scanSummary: null, scanError: '', scanModelUsed: 'none' };
  await progress(onProgress, 38, `全${articles.length}件を低コストスキャン中`);
  const limit = scanTextLimit(articles.length);
  const input = articles.map((a, index) => ({ no: index + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', article_link: articleLink(a), text: excerpt(a, limit) }));
  try {
    const res = await openai.chat.completions.create({
      model: scanModel(),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Return JSON only. Screen all articles and select at most ${max} article_id values for final consumer trend analysis. Required keys: selected_article_ids, clusters, scan_notes.` },
        { role: 'user', content: JSON.stringify({ query, article_count: articles.length, max_final_articles: max, articles: input }) }
      ]
    });
    const parsed = JSON.parse(res.choices[0]?.message.content || '{}') as Record<string, unknown>;
    return { finalArticles: selectByIds(articles, uniqueIds(parsed.selected_article_ids), max), scanSummary: parsed, scanError: '', scanModelUsed: scanModel() };
  } catch (error) {
    return { finalArticles: articles.slice(0, max), scanSummary: null, scanError: error instanceof Error ? error.message : 'scan failed', scanModelUsed: scanModel() };
  }
}

async function runWide(body: Record<string, unknown>, onProgress?: ProgressReporter) {
  const query = text(body.query);
  if (!query) throw new Error('query is required');
  const selectedModel = model(body.model);
  await progress(onProgress, 18, '全記事をページング取得中');
  const allArticles = await fetchAllWideArticles();
  await progress(onProgress, 30, `${allArticles.length}件の記事を取得`);
  const openai = getOpenAI();
  const picked = await selectArticles(query, allArticles, selectedModel, onProgress);
  const finalArticles = picked.finalArticles;
  const base = {
    target_scope: 'all', retrieval_mode: 'wide_all_data_scan', model_used: selectedModel, requested_model: selectedModel,
    scan_enabled: allArticles.length > finalArticles.length, scan_model: picked.scanModelUsed, scan_error: picked.scanError,
    article_count_scanned: allArticles.length, article_count_for_report: finalArticles.length, related_article_count: allArticles.length,
    selected_article_ids: finalArticles.map((a) => a.id), scan_summary: picked.scanSummary,
    source_coverage: { article_count: allArticles.length, scanned_article_count: allArticles.length, final_article_count: finalArticles.length, coverage_note: `全記事${allArticles.length}件をページング取得し、最終分析には${finalArticles.length}件を選抜投入。160件制限は使用していません。` },
    article_lookup: finalArticles.map((a) => ({ article_id: a.id, headline: a.headline || '無題の記事', article_date: a.article_date || '日付不明', article_link: articleLink(a), article_url: `/articles/${a.id}` }))
  };
  if (!openai) return { report: null, report_error: 'OPENAI_API_KEY missing', related_articles: allArticles, selectable_models: models(), answer: { ...base, report_title: '該当記事一覧', answer_text: `OPENAI_API_KEYが未設定のため、全記事${allArticles.length}件の取得情報のみ返します。` } };
  await progress(onProgress, 68, `${selectedModel}で最終レポートを生成中`);
  const n = finalTextLimit(finalArticles.length);
  const finalInput = finalArticles.map((a, index) => ({ no: index + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', article_link: articleLink(a), text: (a.ocr_text || '').slice(0, n) }));
  const res = await openai.chat.completions.create({
    model: selectedModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${MJ_REPORT_SYSTEM_PROMPT}\nUse article_link when citing evidence. Include coverage_diagnosis, evidence_matrix, refutation_audit and research_needs.` },
      ...turns(body.conversation),
      { role: 'user', content: JSON.stringify({ query, coverage: base.source_coverage, scan_summary: picked.scanSummary, articles: finalInput }) }
    ]
  });
  const raw = res.choices[0]?.message.content || '{}';
  const parsed = JSON.parse(raw);
  const answer = { ...base, ...parsed, answer_text: typeof parsed.answer_text === 'string' ? parsed.answer_text : raw };
  let report = null;
  let report_error = '';
  await progress(onProgress, 94, '分析履歴を保存中');
  try {
    const saved = await supabaseAdmin.from('chat_reports').insert({ user_query: query, answer_text: answer.answer_text, answer_json: answer, related_article_ids: allArticles.map((a) => a.id) }).select('*').single();
    if (saved.error) throw saved.error;
    report = saved.data;
  } catch (error) { report_error = error instanceof Error ? error.message : 'chat_reports insert failed'; }
  await progress(onProgress, 100, report_error ? 'レポート生成完了。履歴保存に警告あり' : 'レポート生成完了');
  return { report, report_error, related_articles: allArticles, selectable_models: models(), answer };
}

export async function runChatAnalysis(body: Record<string, unknown>, onProgress?: ProgressReporter) {
  return wantsWide(body) ? runWide(body, onProgress) : legacyRunChatAnalysis(body, onProgress);
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await runChatAnalysis(await req.json()));
  } catch (error) { return jsonError(error); }
}

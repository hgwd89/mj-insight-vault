import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';
import { MJ_REPORT_SYSTEM_PROMPT } from '@/lib/reportPrompt';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Article = { id: string; batch_id?: string | null; headline: string | null; article_date: string | null; ocr_text: string | null; status?: string | null; created_at?: string | null };
type Scope = 'all' | 'recent_30d' | 'latest_batch';
type Template = 'auto' | 'trend' | 'why' | 'research' | 'proposal' | 'method' | 'news_list';
type Turn = { role: 'user' | 'assistant'; content: string };
type AnalysisMode = 'serious_report' | 'quick_scan';
type RetrievalMode = 'focused_retrieval' | 'wide_all_data_scan';
type OpenAIClient = NonNullable<ReturnType<typeof getOpenAI>>;
type ScanOutcome = {
  scan_enabled: boolean;
  scan_model: string;
  article_count_scanned: number;
  article_count_for_report: number;
  selected_article_ids: string[];
  scan_summary: unknown;
  scan_error?: string;
  final_articles: Article[];
};

const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const SELECT = 'id, batch_id, headline, article_date, ocr_text, status, created_at';
const LIGHT_WORDS = /軽く|ざっくり|簡単|概要|一覧|傾向だけ|軽量|速報|まずは|ラフ/i;
const ALL_DATA_WORDS = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/i;

function articleUrl(articleId: string) {
  return `/articles/${articleId}`;
}
function articleLabel(a: Article) {
  return `${a.headline || '無題の記事'}｜${a.article_date || '日付不明'}`;
}
function articleLink(a: Article) {
  return `[${articleLabel(a)}](${articleUrl(a.id)})`;
}
function selectableModels() {
  return Array.from(new Set([TEXT_MODEL, ...(process.env.OPENAI_CHAT_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean), ...MODELS].filter(Boolean)));
}
function scanModel() {
  const configured = (process.env.OPENAI_SCAN_MODEL || 'gpt-5-nano').trim();
  return selectableModels().includes(configured) ? configured : 'gpt-5-nano';
}
function normModel(v: unknown) { return typeof v === 'string' && selectableModels().includes(v) ? v : TEXT_MODEL; }
function normScope(v: unknown): Scope { return v === 'recent_30d' || v === 'latest_batch' ? v : 'all'; }
function normTemplate(v: unknown): Template { return v === 'trend' || v === 'why' || v === 'research' || v === 'proposal' || v === 'method' || v === 'news_list' ? v : 'auto'; }
function active(a: Article) { return !a.status || !HIDDEN.has(a.status); }
function excerpt(a: Article) { return (a.ocr_text || '').replace(/\s+/g, ' ').slice(0, 260); }
function allDataQuery(q: string, scope: Scope) { return scope === 'all' && ALL_DATA_WORDS.test(q); }
function words(q: string) {
  return q.replace(/[、。・「」『』（）()]/g, ' ').split(/\s+/)
    .map((w) => w.replace(/(記事|分析|整理|して|出して|今月|関連|だけ|業界|トレンド|市場|リサーチ|課題|全データ|全記事|全部|全体|全件|すべて|全て)/g, ''))
    .filter((w) => w.length >= 2).slice(0, 10);
}
function turns(v: unknown): Turn[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const r = x && typeof x === 'object' ? x as Record<string, unknown> : {};
    const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null;
    const content = typeof r.content === 'string' ? r.content.slice(0, 6000) : '';
    return role && content ? { role, content } : null;
  }).filter(Boolean).slice(-8) as Turn[];
}
function cards(items: Article[]) {
  return items.slice(0, 18).map((a) => ({
    article_id: a.id,
    headline: a.headline,
    article_date: a.article_date || '日付不明',
    article_url: articleUrl(a.id),
    article_link: articleLink(a),
    reason: '根拠候補',
    confidence: a.article_date ? 'medium' : 'low'
  }));
}
function evidence(items: Article[]) {
  return items.slice(0, 14).map((a) => ({
    claim: '根拠として参照',
    article_id: a.id,
    headline: a.headline,
    article_date: a.article_date || '日付不明',
    article_url: articleUrl(a.id),
    article_link: articleLink(a),
    evidence_excerpt_or_fact: excerpt(a),
    excerpt: excerpt(a),
    confidence: 'medium'
  }));
}
function uniq(rows: Article[]) {
  const seen = new Set<string>();
  return rows.filter(active).filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}
function stringArray(v: unknown) {
  return Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
}
function resolveModel(requested: string, q: string, template: Template) {
  const analysis_mode: AnalysisMode = requested === 'gpt-5' && !LIGHT_WORDS.test(q) && template !== 'news_list' ? 'serious_report' : 'quick_scan';
  return {
    model: requested,
    analysis_mode,
    requested_model: requested,
    model_policy: requested === 'gpt-5'
      ? '選択されたGPT-5で本気レポートを実行'
      : 'コスト抑制のため選択モデルをそのまま使用。自動でGPT-5には昇格しません'
  };
}
function qualityGuard(mode: AnalysisMode) {
  if (mode === 'quick_scan') return 'For quick scan, be concise but still separate facts from hypotheses and include clickable article links. Do not pretend to be final high-quality analysis.';
  return 'For serious report, do not stop at fact organization. Select useful lenses, explain why those lenses fit, build cross-article clusters, produce narrative, 3-level WHY chains, research questions, evidence strength, limits, shallow-read warnings, and clickable article-title evidence links.';
}
function scanTextLimit(count: number) {
  if (count > 120) return 550;
  if (count > 80) return 700;
  return 900;
}
function reportArticleLimit(mode: AnalysisMode, retrievalMode: RetrievalMode) {
  if (retrievalMode !== 'wide_all_data_scan') return 40;
  return mode === 'serious_report' ? 48 : 32;
}
function finalTextLimit(count: number, retrievalMode: RetrievalMode) {
  if (retrievalMode === 'wide_all_data_scan') {
    if (count > 40) return 1800;
    if (count > 30) return 2200;
    return 2600;
  }
  return 4200;
}
function selectArticles(items: Article[], ids: string[], max: number) {
  const byId = new Map(items.map((a) => [a.id, a]));
  const selected = ids.map((id) => byId.get(id)).filter(Boolean) as Article[];
  const used = new Set(selected.map((a) => a.id));
  const backfill = items.filter((a) => !used.has(a.id)).slice(0, Math.max(0, max - selected.length));
  return [...selected, ...backfill].slice(0, max);
}
async function scanArticles(openai: OpenAIClient, q: string, items: Article[], modelInfo: ReturnType<typeof resolveModel>, retrievalMode: RetrievalMode, template: Template): Promise<ScanOutcome> {
  const maxFinal = reportArticleLimit(modelInfo.analysis_mode, retrievalMode);
  const scanner = scanModel();

  if (retrievalMode !== 'wide_all_data_scan' || items.length <= maxFinal) {
    return { scan_enabled: false, scan_model: 'none', article_count_scanned: items.length, article_count_for_report: items.length, selected_article_ids: items.map((a) => a.id), scan_summary: null, final_articles: items };
  }

  try {
    const limit = scanTextLimit(items.length);
    const scanInput = items.map((a, i) => ({ no: i + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', article_url: articleUrl(a.id), article_link: articleLink(a), text: (a.ocr_text || '').slice(0, limit) }));
    const scanSystem = `Return JSON only. This is a low-cost screening step before final report writing. Do not write the final report. Map the diversity of MJ articles, cluster consumer signals, remove weak/noisy articles, and choose the most useful article IDs for final analysis. Select at most ${maxFinal} article IDs. Required keys: coverage_map, clusters, selected_article_ids, rejected_or_low_priority_ids, scan_notes.`;
    const completion = await openai.chat.completions.create({
      model: scanner,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: scanSystem },
        { role: 'user', content: JSON.stringify({ user_query: q, output_template: template, article_count: scanInput.length, max_final_articles: maxFinal, articles: scanInput }, null, 2) }
      ]
    });
    const raw = completion.choices[0]?.message.content || '{}';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ids = stringArray(parsed.selected_article_ids).slice(0, maxFinal);
    const finalArticles = selectArticles(items, ids, maxFinal);
    return { scan_enabled: true, scan_model: scanner, article_count_scanned: items.length, article_count_for_report: finalArticles.length, selected_article_ids: finalArticles.map((a) => a.id), scan_summary: parsed, final_articles: finalArticles };
  } catch (error) {
    const finalArticles = items.slice(0, maxFinal);
    return { scan_enabled: true, scan_model: scanner, article_count_scanned: items.length, article_count_for_report: finalArticles.length, selected_article_ids: finalArticles.map((a) => a.id), scan_summary: null, scan_error: error instanceof Error ? error.message : 'scan failed', final_articles: finalArticles };
  }
}
async function latestBatchId() {
  const { data } = await supabaseAdmin.from('upload_batches').select('id, status, created_at').order('created_at', { ascending: false }).limit(20);
  return (data || []).find((b) => !HIDDEN.has(b.status))?.id || null;
}
async function retrieve(q: string, scope: Scope) {
  const latest = scope === 'latest_batch' ? await latestBatchId() : null;
  const wide = allDataQuery(q, scope);
  let rows: Article[] = [];

  if (wide) {
    const { data, error } = await supabaseAdmin.from('articles').select(SELECT).order('created_at', { ascending: false }).limit(160);
    if (error) throw error;
    return { articles: uniq((data || []) as Article[]).slice(0, 160), retrieval_mode: 'wide_all_data_scan' as RetrievalMode };
  }

  const kw = words(q);
  if (kw.length) {
    const clauses = kw.flatMap((k) => [`headline.ilike.%${k}%`, `ocr_text.ilike.%${k}%`]);
    const { data } = await supabaseAdmin.from('articles').select(SELECT).or(clauses.join(',')).order('created_at', { ascending: false }).limit(120);
    rows = (data || []) as Article[];
  }
  if (rows.length < 10) {
    const { data } = await supabaseAdmin.from('articles').select(SELECT).order('created_at', { ascending: false }).limit(80);
    rows = [...rows, ...((data || []) as Article[])];
  }
  const filtered = uniq(rows).filter((a) => {
    if (scope === 'latest_batch' && latest && a.batch_id !== latest) return false;
    if (scope === 'recent_30d' && a.created_at && Date.now() - new Date(a.created_at).getTime() > 30 * 24 * 60 * 60 * 1000) return false;
    return true;
  });
  return { articles: filtered.slice(0, 40), retrieval_mode: 'focused_retrieval' as RetrievalMode };
}
function basePayload(modelInfo: ReturnType<typeof resolveModel>, scope: Scope, template: Template, allItems: Article[], reportItems: Article[], retrievalMode: RetrievalMode, scan: ScanOutcome) {
  return {
    target_scope: scope,
    output_template: template,
    model_used: modelInfo.model,
    requested_model: modelInfo.requested_model,
    analysis_mode: modelInfo.analysis_mode,
    model_policy: modelInfo.model_policy,
    retrieval_mode: retrievalMode,
    scan_enabled: scan.scan_enabled,
    scan_model: scan.scan_model,
    scan_error: scan.scan_error || '',
    article_count_scanned: scan.article_count_scanned,
    article_count_for_report: scan.article_count_for_report,
    selected_article_ids: scan.selected_article_ids,
    related_article_count: allItems.length,
    source_coverage: { article_count: allItems.length, report_article_count: reportItems.length, coverage_note: retrievalMode === 'wide_all_data_scan' ? `全データ指示のため${allItems.length}件を広域スキャンし、${scan.scan_model}で${reportItems.length}件に選抜して最終分析` : allItems.length ? '対象記事から分析' : '分析対象の記事が不足しています。' },
    scan_summary: scan.scan_summary,
    article_lookup: reportItems.map((a) => ({ article_id: a.id, headline: a.headline || '無題の記事', article_date: a.article_date || '日付不明', article_url: articleUrl(a.id), article_link: articleLink(a) })),
    cards: cards(reportItems),
    evidence: evidence(reportItems)
  };
}
async function analyze(q: string, items: Article[], modelInfo: ReturnType<typeof resolveModel>, scope: Scope, template: Template, conversation: Turn[], retrievalMode: RetrievalMode) {
  if (!items.length) {
    const emptyScan: ScanOutcome = { scan_enabled: false, scan_model: 'none', article_count_scanned: 0, article_count_for_report: 0, selected_article_ids: [], scan_summary: null, final_articles: [] };
    return { report_title: '該当記事なし', answer_text: '指定範囲に分析対象の記事がありません。', table: [], ...basePayload(modelInfo, scope, template, [], [], retrievalMode, emptyScan) };
  }
  const openai = getOpenAI();
  if (!openai) {
    const noScan: ScanOutcome = { scan_enabled: false, scan_model: 'none', article_count_scanned: items.length, article_count_for_report: items.length, selected_article_ids: items.map((a) => a.id), scan_summary: null, final_articles: items };
    return { report_title: '該当記事一覧', answer_text: `OPENAI_API_KEYが未設定のため、該当記事${items.length}件のみ返します。`, table: [], ...basePayload(modelInfo, scope, template, items, items, retrievalMode, noScan) };
  }

  const scan = await scanArticles(openai, q, items, modelInfo, retrievalMode, template);
  const reportItems = scan.final_articles;
  const base = basePayload(modelInfo, scope, template, items, reportItems, retrievalMode, scan);
  const limit = finalTextLimit(reportItems.length, retrievalMode);
  const articles = reportItems.map((a, i) => ({ no: i + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', article_url: articleUrl(a.id), article_link: articleLink(a), created_at: a.created_at || null, text: (a.ocr_text || '').slice(0, limit) }));
  const system = `${MJ_REPORT_SYSTEM_PROMPT}\n\n${qualityGuard(modelInfo.analysis_mode)}\nIf scan_enabled is true, use scan_summary to preserve article diversity and do not overfit to one cluster. Use article_link or [headline｜date](article_url) in answer_text whenever citing evidence. Return selected_lenses, analysis_process, quality_score, and shallow_summary_check in JSON.`;
  try {
    const completion = await openai.chat.completions.create({ model: modelInfo.model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...conversation, { role: 'user', content: JSON.stringify({ user_query: q, target_scope: scope, output_template: template, analysis_mode: modelInfo.analysis_mode, requested_model: modelInfo.requested_model, model_used: modelInfo.model, retrieval_mode: retrievalMode, scan_enabled: scan.scan_enabled, scan_model: scan.scan_model, article_count_scanned: scan.article_count_scanned, article_count_for_report: scan.article_count_for_report, scan_summary: scan.scan_summary, article_text_limit: limit, articles }, null, 2) }] });
    const raw = completion.choices[0]?.message.content || '{}';
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed, answer_text: typeof parsed.answer_text === 'string' ? parsed.answer_text : raw, evidence: Array.isArray(parsed.evidence_matrix) && parsed.evidence_matrix.length ? parsed.evidence_matrix : base.evidence, cards: Array.isArray(parsed.cards) && parsed.cards.length ? parsed.cards : base.cards };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI analysis failed';
    return { report_title: '分析エラー', answer_text: `OpenAI分析でエラーが出ました。取得${items.length}件、最終投入${reportItems.length}件までは完了しています。エラー: ${message}`, table: [], ...base };
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json();
    const q = body.query;
    if (!q || typeof q !== 'string') return Response.json({ error: 'query is required' }, { status: 400 });
    const requested = normModel(body.model);
    const targetScope = normScope(body.target_scope);
    const outputTemplate = normTemplate(body.output_template);
    const modelInfo = resolveModel(requested, q, outputTemplate);
    const retrieval = await retrieve(q, targetScope);
    const answer = await analyze(q, retrieval.articles, modelInfo, targetScope, outputTemplate, turns(body.conversation), retrieval.retrieval_mode);
    let report = null;
    let report_error = '';
    try {
      const { data, error } = await supabaseAdmin.from('chat_reports').insert({ user_query: q, answer_text: answer.answer_text, answer_json: answer, related_article_ids: retrieval.articles.map((a) => a.id) }).select('*').single();
      if (error) throw error;
      report = data;
    } catch (error) {
      report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
    }
    return Response.json({ report, report_error, related_articles: retrieval.articles, selectable_models: selectableModels(), answer });
  } catch (error) {
    return jsonError(error);
  }
}

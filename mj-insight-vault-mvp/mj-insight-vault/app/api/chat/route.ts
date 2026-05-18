import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Article = { id: string; headline: string | null; article_date: string | null; ocr_text: string | null; status?: string | null; created_at?: string | null };
type Scope = 'all' | 'recent_30d' | 'latest_batch';
type Template = 'auto' | 'trend' | 'why' | 'research' | 'proposal' | 'method' | 'news_list';
type Turn = { role: 'user' | 'assistant'; content: string };

const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const SELECT = 'id, headline, article_date, ocr_text, status, created_at';

function selectableModels() {
  return Array.from(new Set([TEXT_MODEL, ...(process.env.OPENAI_CHAT_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean), ...MODELS].filter(Boolean)));
}
function normModel(v: unknown) { return typeof v === 'string' && selectableModels().includes(v) ? v : TEXT_MODEL; }
function normScope(v: unknown): Scope { return v === 'recent_30d' || v === 'latest_batch' ? v : 'all'; }
function normTemplate(v: unknown): Template { return v === 'trend' || v === 'why' || v === 'research' || v === 'proposal' || v === 'method' || v === 'news_list' ? v : 'auto'; }
function active(a: Article) { return !a.status || !HIDDEN.has(a.status); }
function words(q: string) { return q.replace(/[、。・「」『』（）()]/g, ' ').split(/\s+/).map((w) => w.replace(/(記事|分析|整理|して|出して|今月|関連|だけ|業界|トレンド|市場|リサーチ|課題)/g, '')).filter((w) => w.length >= 2).slice(0, 10); }
function turns(v: unknown): Turn[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const r = x && typeof x === 'object' ? x as Record<string, unknown> : {};
    const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null;
    const content = typeof r.content === 'string' ? r.content.slice(0, 6000) : '';
    return role && content ? { role, content } : null;
  }).filter(Boolean).slice(-8) as Turn[];
}
function excerpt(a: Article) { return (a.ocr_text || '').replace(/\s+/g, ' ').slice(0, 260); }
function cards(items: Article[]) { return items.slice(0, 12).map((a) => ({ article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', reason: '根拠候補', confidence: a.article_date ? 'medium' : 'low' })); }
function evidence(items: Article[]) { return items.slice(0, 10).map((a) => ({ claim: '根拠として参照', article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', excerpt: excerpt(a), confidence: 'medium' })); }

async function latestBatchId() {
  const { data } = await supabaseAdmin.from('upload_batches').select('id, status, created_at').order('created_at', { ascending: false }).limit(20);
  return (data || []).find((b) => !HIDDEN.has(b.status))?.id || null;
}
async function retrieve(q: string, scope: Scope) {
  const kw = words(q);
  const latest = scope === 'latest_batch' ? await latestBatchId() : null;
  let rows: Article[] = [];
  if (kw.length) {
    const clauses = kw.flatMap((k) => [`headline.ilike.%${k}%`, `ocr_text.ilike.%${k}%`]);
    const { data } = await supabaseAdmin.from('articles').select(SELECT).or(clauses.join(',')).order('created_at', { ascending: false }).limit(120);
    rows = (data || []) as Article[];
  }
  if (rows.length < 10) {
    const { data } = await supabaseAdmin.from('articles').select(SELECT).order('created_at', { ascending: false }).limit(80);
    rows = [...rows, ...((data || []) as Article[])];
  }
  const seen = new Set<string>();
  return rows.filter(active).filter((a) => {
    if (scope === 'latest_batch' && latest && (a as Article & { batch_id?: string | null }).batch_id !== latest) return false;
    if (scope === 'recent_30d' && a.created_at && Date.now() - new Date(a.created_at).getTime() > 30 * 24 * 60 * 60 * 1000) return false;
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  }).slice(0, 40);
}
function basePayload(model: string, scope: Scope, template: Template, items: Article[]) {
  return { target_scope: scope, output_template: template, model_used: model, related_article_count: items.length, source_coverage: { article_count: items.length, coverage_note: items.length ? '対象記事から分析' : '分析対象の記事が不足しています。' }, cards: cards(items), evidence: evidence(items) };
}
async function analyze(q: string, items: Article[], model: string, scope: Scope, template: Template, conversation: Turn[]) {
  const base = basePayload(model, scope, template, items);
  if (!items.length) return { report_title: '該当記事なし', answer_text: '指定範囲に分析対象の記事がありません。', table: [], ...base };
  const openai = getOpenAI();
  if (!openai) return { report_title: '該当記事一覧', answer_text: `OPENAI_API_KEYが未設定のため、該当記事${items.length}件のみ返します。`, table: [], ...base };
  const articles = items.map((a, i) => ({ no: i + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', text: (a.ocr_text || '').slice(0, 4200) }));
  const system = 'Return JSON only. Analyze the supplied MJ article texts as consumer trend evidence. Required keys: report_title, answer_text, executive_summary, consumer_trend_narrative, key_findings, evidence, table, cards, limitations, next_questions, quality_score. Connect important claims to article IDs and do not assert unsupported claims.';
  try {
    const completion = await openai.chat.completions.create({ model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...conversation, { role: 'user', content: JSON.stringify({ user_query: q, target_scope: scope, output_template: template, articles }, null, 2) }] });
    const raw = completion.choices[0]?.message.content || '{}';
    const parsed = JSON.parse(raw);
    return { ...base, ...parsed, answer_text: typeof parsed.answer_text === 'string' ? parsed.answer_text : raw, evidence: Array.isArray(parsed.evidence) && parsed.evidence.length ? parsed.evidence : base.evidence, cards: Array.isArray(parsed.cards) && parsed.cards.length ? parsed.cards : base.cards };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI analysis failed';
    return { report_title: '分析エラー', answer_text: `OpenAI分析でエラーが出ました。該当記事${items.length}件は取得できています。エラー: ${message}`, table: [], ...base };
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json();
    const q = body.query;
    if (!q || typeof q !== 'string') return Response.json({ error: 'query is required' }, { status: 400 });
    const model = normModel(body.model);
    const targetScope = normScope(body.target_scope);
    const outputTemplate = normTemplate(body.output_template);
    const related = await retrieve(q, targetScope);
    const answer = await analyze(q, related, model, targetScope, outputTemplate, turns(body.conversation));
    let report = null;
    let report_error = '';
    try {
      const { data, error } = await supabaseAdmin.from('chat_reports').insert({ user_query: q, answer_text: answer.answer_text, answer_json: answer, related_article_ids: related.map((a) => a.id) }).select('*').single();
      if (error) throw error;
      report = data;
    } catch (error) {
      report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
    }
    return Response.json({ report, report_error, related_articles: related, selectable_models: selectableModels(), answer });
  } catch (error) {
    return jsonError(error);
  }
}

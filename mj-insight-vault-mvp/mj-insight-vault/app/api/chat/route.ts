import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { embedText, getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

type TargetScope = 'all' | 'recent_30d' | 'latest_batch';
type OutputTemplate = 'auto' | 'trend' | 'why' | 'research' | 'proposal' | 'method' | 'news_list';
type ConversationTurn = { role: 'user' | 'assistant'; content: string };
type ArticleContext = {
  id: string;
  batch_id?: string | null;
  headline: string | null;
  article_date?: string | null;
  ocr_text: string | null;
  status?: string | null;
  created_at?: string | null;
  article_tags?: { tag_type: string; tag_name: string }[];
};
type EvidenceItem = { insight?: string; claim?: string; article_id?: string; headline?: string | null; article_date?: string | null; excerpt?: string; confidence?: string };
type Industry = { key: string; label: string; terms: string[] };

const ARTICLE_SELECT = 'id, batch_id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)';
const HIDDEN_STATUSES = new Set(['deleted', 'excluded', 'rejected']);
const DEFAULT_CHAT_MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const INDUSTRIES: Industry[] = [
  { key: 'cosmetics', label: '化粧品・美容', terms: ['化粧品', 'コスメ', '美容', 'スキンケア', 'ヘアケア', 'メイク', 'メーキャップ', '化粧水', '乳液', '美容液', 'ファンデーション', '口紅', 'リップ', 'アイシャドウ', '香水', '日焼け止め', 'UV', 'ネイル', '資生堂', 'コーセー', 'ポーラ', 'マンダム'] },
  { key: 'food', label: '食品・飲料', terms: ['食品', '飲料', '外食', '冷食', '冷凍食品', 'スーパー', 'コンビニ', '菓子', 'ヨーグルト', '惣菜', '弁当', 'ポッポ', 'ローソン', 'セブン', 'ファミマ', '飲むヨーグレット', 'みそ汁', 'たんぱく質', '米', 'パン', 'カフェ'] },
  { key: 'ai', label: 'AI・テクノロジー', terms: ['AI', '人工知能', '生成AI', 'ChatGPT', 'チャットGPT', 'LLM', 'ロボット', '自動化', '無人', 'デジタル', 'アプリ', 'SaaS'] }
];

function selectableModels() {
  const env = (process.env.OPENAI_CHAT_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean);
  return Array.from(new Set([TEXT_MODEL, ...env, ...DEFAULT_CHAT_MODELS].filter(Boolean)));
}
function normalizeModel(value: unknown) { const models = selectableModels(); return typeof value === 'string' && models.includes(value) ? value : TEXT_MODEL; }
function normalizeTargetScope(value: unknown): TargetScope { return value === 'recent_30d' || value === 'latest_batch' ? value : 'all'; }
function normalizeOutputTemplate(value: unknown): OutputTemplate {
  return value === 'trend' || value === 'why' || value === 'research' || value === 'proposal' || value === 'method' || value === 'news_list' ? value : 'auto';
}
function normalizeConversation(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return [];
  return value.map((turn) => {
    if (!turn || typeof turn !== 'object') return null;
    const r = turn as Record<string, unknown>;
    const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null;
    const content = typeof r.content === 'string' ? r.content.trim() : '';
    return role && content ? { role, content: content.slice(0, 6000) } : null;
  }).filter(Boolean).slice(-8) as ConversationTurn[];
}
function isActiveArticle(a: ArticleContext) { return !a.status || !HIDDEN_STATUSES.has(a.status); }
function uniqueArticles(articles: ArticleContext[]) { const seen = new Set<string>(); return articles.filter((a) => a.id && !seen.has(a.id) && seen.add(a.id)); }
function escapeLike(value: string) { return value.replace(/[%_,]/g, ' ').trim(); }
function articleText(a: ArticleContext) { return `${a.headline || ''}\n${a.ocr_text || ''}\n${(a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`).join('\n')}`; }
function detectIndustry(query: string) { const q = query.toLowerCase(); return INDUSTRIES.find((i) => i.terms.some((term) => q.includes(term.toLowerCase()))) || null; }
function matchesIndustry(a: ArticleContext, industry: Industry) { const t = articleText(a).toLowerCase(); return industry.terms.some((term) => t.includes(term.toLowerCase())); }
function industryQuery(query: string) { return Boolean(detectIndustry(query) && /業界|関連|カテゴリー|カテゴリ|市場|トレンド|だけ|のみ/.test(query)); }
function keywords(query: string) {
  const out = new Set<string>();
  const industry = detectIndustry(query);
  if (industry) industry.terms.forEach((term) => out.add(term));
  query.replace(/[、。・「」『』（）()]/g, ' ').split(/\s+/).map((w) => w.trim()).filter(Boolean).map((w) => w.replace(/(だけ|関連|記事|分析|して|出して|整理|業界|今月分|今月|リサーチ|課題|テーマ|向いている|回すべき|ください|トレンド|市場)/g, '')).filter((w) => w.length >= 2).slice(0, 8).forEach((w) => out.add(w));
  return Array.from(out).map(escapeLike).filter(Boolean).slice(0, 16);
}
async function latestBatchId() {
  const { data, error } = await supabaseAdmin.from('upload_batches').select('id, status, created_at').order('created_at', { ascending: false }).limit(20);
  if (error) return null;
  return (data || []).find((b) => !HIDDEN_STATUSES.has(b.status))?.id || null;
}
function scopeFilter(articles: ArticleContext[], targetScope: TargetScope, latestId: string | null) {
  if (targetScope === 'latest_batch') return latestId ? articles.filter((a) => a.batch_id === latestId) : [];
  if (targetScope === 'recent_30d') { const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; return articles.filter((a) => a.created_at && new Date(a.created_at).getTime() >= cutoff); }
  return articles;
}
async function keywordArticles(query: string) {
  const ks = keywords(query);
  if (!ks.length) return [] as ArticleContext[];
  const clauses = ks.flatMap((k) => [`headline.ilike.%${k}%`, `ocr_text.ilike.%${k}%`]);
  const { data, error } = await supabaseAdmin.from('articles').select(ARTICLE_SELECT).or(clauses.join(',')).order('created_at', { ascending: false }).limit(150);
  if (error) { console.error('Keyword retrieval failed:', error); return []; }
  return ((data || []) as ArticleContext[]).filter(isActiveArticle);
}
async function embeddingArticles(query: string) {
  const embedding = await embedText(query);
  if (!embedding) return [] as ArticleContext[];
  const { data, error } = await supabaseAdmin.rpc('match_articles', { query_embedding: embedding, match_count: 30 });
  if (error) { console.error('Embedding retrieval failed:', error); return []; }
  const ids = (data || []).map((r: { article_id?: string }) => r.article_id).filter(Boolean) as string[];
  if (!ids.length) return [];
  const { data: articles, error: articleError } = await supabaseAdmin.from('articles').select(ARTICLE_SELECT).in('id', ids);
  if (articleError) throw articleError;
  const byId = new Map(((articles || []) as ArticleContext[]).filter(isActiveArticle).map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as ArticleContext[];
}
async function recentArticles() {
  const { data, error } = await supabaseAdmin.from('articles').select(ARTICLE_SELECT).order('created_at', { ascending: false }).limit(80);
  if (error) throw error;
  return ((data || []) as ArticleContext[]).filter(isActiveArticle);
}
async function retrieve(query: string, targetScope: TargetScope) {
  const industry = detectIndustry(query);
  const strictIndustry = industryQuery(query);
  const latestId = targetScope === 'latest_batch' ? await latestBatchId() : null;
  const kw = scopeFilter(await keywordArticles(query), targetScope, latestId);
  if (strictIndustry && industry) return { articles: uniqueArticles(kw).filter((a) => matchesIndustry(a, industry)).slice(0, 40), industry, strictIndustry };
  const emb = scopeFilter(await embeddingArticles(query), targetScope, latestId);
  const recent = scopeFilter(await recentArticles(), targetScope, latestId);
  return { articles: uniqueArticles([...kw, ...emb, ...recent]).slice(0, 40), industry, strictIndustry };
}
function templateInstruction(t: OutputTemplate) {
  if (t === 'trend') return '生活者トレンド、背景、心理、企業示唆、調査仮説に分けてください。';
  if (t === 'why') return 'WHYを最低5段階で掘り下げ、最後に本質仮説を出してください。';
  if (t === 'research') return '調査目的、検証仮説、対象者条件、聞くべき論点、適した手法を出してください。';
  if (t === 'proposal') return '提案タイトル、クライアント課題、記事根拠、提案骨子、勝ち筋を出してください。';
  if (t === 'method') return 'N1探索、投影、BOT、リフレクション、定量の適性を根拠付きで評価してください。';
  if (t === 'news_list') return '記事ごとに日付、見出し、主要事実、生活者変化、使い道を表形式で出してください。';
  return '質問内容に合う形式で、実務で使える分析にしてください。';
}
function excerpt(a: ArticleContext, query: string) {
  const text = a.ocr_text || '';
  const hit = keywords(query).find((k) => text.includes(k));
  if (!hit) return text.slice(0, 160);
  return text.slice(Math.max(0, text.indexOf(hit) - 60), Math.max(0, text.indexOf(hit) - 60) + 180);
}
function cards(articles: ArticleContext[]) { return articles.slice(0, 12).map((a) => ({ article_id: a.id, headline: a.headline, article_date: a.article_date, reason: '直接該当記事' })); }
function evidence(value: unknown, articles: ArticleContext[], query: string): EvidenceItem[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const raw = Array.isArray(value) ? value : [];
  const normalized: EvidenceItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as EvidenceItem;
    const a = r.article_id ? byId.get(r.article_id) : undefined;
    if (!a) continue;
    normalized.push({ insight: String(r.insight || r.claim || '').slice(0, 220), claim: String(r.claim || r.insight || '').slice(0, 220), article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', excerpt: String(r.excerpt || excerpt(a, query)).slice(0, 240), confidence: r.confidence || 'medium' });
  }
  return normalized.length ? normalized.slice(0, 20) : articles.slice(0, 8).map((a) => ({ insight: '直接該当記事', claim: '根拠として参照', article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', excerpt: excerpt(a, query), confidence: 'medium' }));
}
function noIndustryMessage(query: string, industry: Industry, targetScope: TargetScope) {
  return `${industry.label}として直接扱える記事が指定範囲に見つかりませんでした。\n周辺トピックを無理に接続せず、直接該当記事がある場合だけ分析します。\n検索条件: ${query}\n対象範囲: ${targetScope}`;
}
async function analyze(query: string, articles: ArticleContext[], model: string, targetScope: TargetScope, outputTemplate: OutputTemplate, conversation: ConversationTurn[], industry: Industry | null, strictIndustry: boolean) {
  const openai = getOpenAI();
  const baseMeta = { industry_filter: industry ? { key: industry.key, label: industry.label, strict: strictIndustry } : null, target_scope: targetScope, output_template: outputTemplate, model_used: model, related_article_count: articles.length };
  if (!articles.length) return { answer_text: industry && strictIndustry ? noIndustryMessage(query, industry, targetScope) : '指定範囲に分析対象の記事がありません。', table: [], cards: [], evidence: [], insights: [], ...baseMeta };
  const fallbackCards = cards(articles);
  if (!openai) return { answer_text: `OPENAI_API_KEYが未設定のため、該当記事${articles.length}件のみ返します。`, table: [], cards: fallbackCards, evidence: evidence([], articles, query), insights: [], ...baseMeta };

  const articleContext = articles.map((a, i) => ({ no: i + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', tags: (a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`), text: (a.ocr_text || '').slice(0, 3000) }));
  const system = [
    'あなたはマーケティングリサーチの上級コンサルタントです。回答は必ずJSONです。',
    '必ず answer_text, table, cards, evidence, insights を含めてください。',
    strictIndustry && industry ? `対象業界は「${industry.label}」。記事本文や見出しに直接該当する記事だけを根拠にしてください。周辺テーマを業界へ類推接続しないでください。該当記事が少ない場合は限定的と明記してください。` : '',
    templateInstruction(outputTemplate),
    'cardsには根拠記事IDを含めてください。evidenceは insight, claim, article_id, headline, article_date, excerpt, confidence を含めてください。',
    '記事にない内容は断定せず、必要なら仮説と明記してください。日本語で回答してください。'
  ].filter(Boolean).join('\n');

  try {
    const completion = await openai.chat.completions.create({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...conversation, { role: 'user', content: JSON.stringify({ user_query: query, target_scope: targetScope, output_template: outputTemplate, industry_filter: baseMeta.industry_filter, article_count: articleContext.length, articles: articleContext }, null, 2) }] });
    const raw = completion.choices[0]?.message.content || '{}';
    try {
      const parsed = JSON.parse(raw);
      return { answer_text: typeof parsed.answer_text === 'string' ? parsed.answer_text : typeof parsed.summary === 'string' ? parsed.summary : raw, table: Array.isArray(parsed.table) ? parsed.table : [], cards: Array.isArray(parsed.cards) ? parsed.cards : fallbackCards, insights: Array.isArray(parsed.insights) ? parsed.insights : [], ...parsed, evidence: evidence(parsed.evidence, articles, query), ...baseMeta };
    } catch {
      return { answer_text: raw, table: [], cards: fallbackCards, evidence: evidence([], articles, query), insights: [], ...baseMeta };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI analysis failed';
    return { answer_text: `OpenAI分析でエラーが出ました。該当記事${articles.length}件は取得できています。エラー: ${message}`, table: [], cards: fallbackCards, evidence: evidence([], articles, query), insights: [], ...baseMeta };
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json();
    const query = body.query;
    if (!query || typeof query !== 'string') return Response.json({ error: 'query is required' }, { status: 400 });
    const model = normalizeModel(body.model);
    const targetScope = normalizeTargetScope(body.target_scope);
    const outputTemplate = normalizeOutputTemplate(body.output_template);
    const conversation = normalizeConversation(body.conversation);
    const retrieval = await retrieve(query, targetScope);
    const answer = await analyze(query, retrieval.articles, model, targetScope, outputTemplate, conversation, retrieval.industry, retrieval.strictIndustry);

    let report = null;
    let report_error = '';
    try {
      const { data, error } = await supabaseAdmin.from('chat_reports').insert({ user_query: query, answer_text: answer.answer_text, answer_json: answer, related_article_ids: retrieval.articles.map((a) => a.id) }).select('*').single();
      if (error) throw error;
      report = data;
    } catch (error) {
      report_error = error instanceof Error ? error.message : 'chat_reports insert failed';
      console.error('chat_reports insert failed:', error);
    }
    return Response.json({ report, report_error, related_articles: retrieval.articles, selectable_models: selectableModels(), answer });
  } catch (error) {
    return jsonError(error);
  }
}

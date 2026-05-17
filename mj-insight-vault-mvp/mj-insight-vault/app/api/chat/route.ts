import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { embedText, getOpenAI, TEXT_MODEL } from '@/lib/openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

type TargetScope = 'all' | 'recent_30d' | 'latest_batch';
type OutputTemplate = 'auto' | 'trend' | 'why' | 'research' | 'proposal' | 'method' | 'news_list';
type Turn = { role: 'user' | 'assistant'; content: string };
type Article = { id: string; batch_id?: string | null; headline: string | null; article_date?: string | null; ocr_text: string | null; status?: string | null; created_at?: string | null; article_tags?: { tag_type: string; tag_name: string }[] };
type Industry = { key: string; label: string; terms: string[] };

const ARTICLE_SELECT = 'id, batch_id, headline, article_date, ocr_text, status, created_at, article_tags(tag_type, tag_name)';
const HIDDEN = new Set(['deleted', 'excluded', 'rejected']);
const MODELS = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const METHOD_RE = /手法|N1|投影|BOT|リフレクション|定量|定性|インタビュー|アンケート|調査設計|リサーチ課題|対象者|サンプル|仮説|提案書|method/i;
const INDUSTRIES: Industry[] = [
  { key: 'cosmetics', label: '化粧品・美容', terms: ['化粧品', 'コスメ', '美容', 'スキンケア', 'ヘアケア', 'メイク', 'メーキャップ', '化粧水', '乳液', '美容液', 'ファンデーション', '口紅', 'リップ', 'アイシャドウ', '香水', '日焼け止め', 'UV', 'ネイル', '資生堂', 'コーセー', 'ポーラ', 'マンダム'] },
  { key: 'food', label: '食品・飲料', terms: ['食品', '飲料', '外食', '冷食', '冷凍食品', 'スーパー', 'コンビニ', '菓子', 'ヨーグルト', '惣菜', '弁当', 'ポッポ', 'ローソン', 'セブン', 'ファミマ', '飲むヨーグレット', 'みそ汁', 'たんぱく質', '米', 'パン', 'カフェ'] },
  { key: 'ai', label: 'AI・テクノロジー', terms: ['AI', '人工知能', '生成AI', 'ChatGPT', 'チャットGPT', 'LLM', 'ロボット', '自動化', '無人', 'デジタル', 'アプリ', 'SaaS'] }
];

const selectableModels = () => Array.from(new Set([TEXT_MODEL, ...(process.env.OPENAI_CHAT_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean), ...MODELS].filter(Boolean)));
const normModel = (v: unknown) => typeof v === 'string' && selectableModels().includes(v) ? v : TEXT_MODEL;
const normScope = (v: unknown): TargetScope => v === 'recent_30d' || v === 'latest_batch' ? v : 'all';
const normTemplate = (v: unknown): OutputTemplate => v === 'trend' || v === 'why' || v === 'research' || v === 'proposal' || v === 'method' || v === 'news_list' ? v : 'auto';
const active = (a: Article) => !a.status || !HIDDEN.has(a.status);
const textOf = (a: Article) => `${a.headline || ''}\n${a.ocr_text || ''}\n${(a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`).join('\n')}`;
const detectIndustry = (q: string) => INDUSTRIES.find((i) => i.terms.some((t) => q.toLowerCase().includes(t.toLowerCase()))) || null;
const industryQuery = (q: string) => Boolean(detectIndustry(q) && /業界|関連|カテゴリー|カテゴリ|市場|トレンド|だけ|のみ/.test(q));
const methodLayer = (q: string, t: OutputTemplate) => t === 'method' || t === 'research' || t === 'proposal' || METHOD_RE.test(q);
const safeArray = (v: unknown) => Array.isArray(v) ? v : [];

function conversation(v: unknown): Turn[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (!x || typeof x !== 'object') return null;
    const r = x as Record<string, unknown>;
    const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null;
    const content = typeof r.content === 'string' ? r.content.trim() : '';
    return role && content ? { role, content: content.slice(0, 6000) } : null;
  }).filter(Boolean).slice(-8) as Turn[];
}
function keywords(q: string) {
  const out = new Set<string>();
  const ind = detectIndustry(q);
  if (ind) ind.terms.forEach((t) => out.add(t));
  q.replace(/[、。・「」『』（）()]/g, ' ').split(/\s+/).map((w) => w.trim()).filter(Boolean).map((w) => w.replace(/(だけ|関連|記事|分析|して|出して|整理|業界|今月分|今月|リサーチ|課題|テーマ|向いている|回すべき|ください|トレンド|市場)/g, '')).filter((w) => w.length >= 2).slice(0, 8).forEach((w) => out.add(w));
  return Array.from(out).map((v) => v.replace(/[%_,]/g, ' ').trim()).filter(Boolean).slice(0, 16);
}
function uniq(items: Article[]) { const seen = new Set<string>(); return items.filter((a) => a.id && !seen.has(a.id) && seen.add(a.id)); }
async function latestBatchId() {
  const { data } = await supabaseAdmin.from('upload_batches').select('id, status, created_at').order('created_at', { ascending: false }).limit(20);
  return (data || []).find((b) => !HIDDEN.has(b.status))?.id || null;
}
function scope(items: Article[], s: TargetScope, latestId: string | null) {
  if (s === 'latest_batch') return latestId ? items.filter((a) => a.batch_id === latestId) : [];
  if (s === 'recent_30d') { const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; return items.filter((a) => a.created_at && new Date(a.created_at).getTime() >= cutoff); }
  return items;
}
async function keywordArticles(q: string) {
  const ks = keywords(q);
  if (!ks.length) return [] as Article[];
  const clauses = ks.flatMap((k) => [`headline.ilike.%${k}%`, `ocr_text.ilike.%${k}%`]);
  const { data, error } = await supabaseAdmin.from('articles').select(ARTICLE_SELECT).or(clauses.join(',')).order('created_at', { ascending: false }).limit(150);
  if (error) return [];
  return ((data || []) as Article[]).filter(active);
}
async function embeddingArticles(q: string) {
  const emb = await embedText(q);
  if (!emb) return [] as Article[];
  const { data, error } = await supabaseAdmin.rpc('match_articles', { query_embedding: emb, match_count: 30 });
  if (error) return [];
  const ids = (data || []).map((r: { article_id?: string }) => r.article_id).filter(Boolean) as string[];
  if (!ids.length) return [];
  const { data: rows, error: rowError } = await supabaseAdmin.from('articles').select(ARTICLE_SELECT).in('id', ids);
  if (rowError) throw rowError;
  const byId = new Map(((rows || []) as Article[]).filter(active).map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as Article[];
}
async function recentArticles() {
  const { data, error } = await supabaseAdmin.from('articles').select(ARTICLE_SELECT).order('created_at', { ascending: false }).limit(80);
  if (error) throw error;
  return ((data || []) as Article[]).filter(active);
}
async function retrieve(q: string, s: TargetScope) {
  const ind = detectIndustry(q);
  const strictIndustry = industryQuery(q);
  const latestId = s === 'latest_batch' ? await latestBatchId() : null;
  const kw = scope(await keywordArticles(q), s, latestId);
  if (strictIndustry && ind) return { articles: uniq(kw).filter((a) => ind.terms.some((t) => textOf(a).toLowerCase().includes(t.toLowerCase()))).slice(0, 40), industry: ind, strictIndustry };
  return { articles: uniq([...kw, ...scope(await embeddingArticles(q), s, latestId), ...scope(await recentArticles(), s, latestId)]).slice(0, 40), industry: ind, strictIndustry };
}
function excerpt(a: Article, q: string) {
  const text = a.ocr_text || '';
  const hit = keywords(q).find((k) => text.includes(k));
  if (!hit) return text.slice(0, 220);
  const start = Math.max(0, text.indexOf(hit) - 80);
  return text.slice(start, start + 260);
}
function cards(items: Article[]) { return items.slice(0, 12).map((a) => ({ article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', reason: '直接該当記事', confidence: a.article_date ? 'medium' : 'low' })); }
function evidence(raw: unknown, items: Article[], q: string) {
  const byId = new Map(items.map((a) => [a.id, a]));
  const arr = Array.isArray(raw) ? raw : [];
  const out = arr.flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const r = x as Record<string, unknown>;
    const a = typeof r.article_id === 'string' ? byId.get(r.article_id) : undefined;
    if (!a) return [];
    return [{ insight: String(r.insight || r.claim || '').slice(0, 260), claim: String(r.claim || r.insight || '').slice(0, 260), article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', excerpt: String(r.excerpt || excerpt(a, q)).slice(0, 300), confidence: String(r.confidence || 'medium') }];
  });
  return out.length ? out.slice(0, 24) : items.slice(0, 10).map((a) => ({ insight: '直接該当記事', claim: '根拠として参照', article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', excerpt: excerpt(a, q), confidence: 'medium' }));
}
function templateInstruction(t: OutputTemplate, withMethod: boolean) {
  if (t === 'trend') return '生活者トレンドとして、変化の兆し、背景、生活者心理、マーケティング示唆を分ける。';
  if (t === 'why') return 'WHYを最低5段階で掘り下げ、根拠から言えることと仮説を分ける。';
  if (t === 'research') return '生活者動向を整理したうえで、最後に確認すべき問いへ落とす。';
  if (t === 'proposal') return '生活者動向を起点に、提案に使える市場・ブランド示唆へ落とす。';
  if (t === 'method') return 'この場合のみ手法適性を比較する。ただし本文の主役は生活者動向。';
  if (t === 'news_list') return '記事ごとに日付、見出し、主要事実、生活者変化、使い道を表形式で出す。';
  return withMethod ? '生活者動向を主軸にし、必要な場合だけ調査設計を補足する。' : '生活者動向を主軸にし、調査手法提案には踏み込まない。';
}
function emptyPayload(model: string, s: TargetScope, t: OutputTemplate, ind: Industry | null, strict: boolean, count: number, withMethod: boolean) {
  return { executive_summary: [], source_coverage: { article_count: count, coverage_note: '分析対象の記事が不足しています。' }, consumer_trend_narrative: '', key_findings: [], consumer_insights: [], behavior_shifts: [], tension_map: [], market_implications: [], limitations: ['分析対象の記事が不足しています。'], rejected_connections: [], next_questions: ['該当記事を追加する', '分析対象範囲を見直す'], ...(withMethod ? { research_opportunities: [], method_fit: [] } : {}), quality_score: { evidence_strength: count ? 2 : 1, consumer_understanding: 1, strategic_usefulness: 1, originality: 1, overall: 1, reason: '根拠記事が不足しています。' }, industry_filter: ind ? { key: ind.key, label: ind.label, strict } : null, target_scope: s, output_template: t, model_used: model, related_article_count: count, method_layer: withMethod };
}
async function analyze(q: string, items: Article[], model: string, s: TargetScope, t: OutputTemplate, turns: Turn[], ind: Industry | null, strict: boolean) {
  const withMethod = methodLayer(q, t);
  const meta = { industry_filter: ind ? { key: ind.key, label: ind.label, strict } : null, target_scope: s, output_template: t, model_used: model, related_article_count: items.length, method_layer: withMethod };
  if (!items.length) return { report_title: '該当記事なし', answer_text: ind && strict ? `${ind.label}として直接扱える記事が指定範囲に見つかりませんでした。` : '指定範囲に分析対象の記事がありません。', table: [], cards: [], evidence: [], insights: [], ...emptyPayload(model, s, t, ind, strict, 0, withMethod) };
  const fallbackCards = cards(items);
  const openai = getOpenAI();
  if (!openai) return { report_title: '該当記事一覧', answer_text: `OPENAI_API_KEYが未設定のため、該当記事${items.length}件のみ返します。`, table: [], cards: fallbackCards, evidence: evidence([], items, q), insights: [], ...emptyPayload(model, s, t, ind, strict, items.length, withMethod), ...meta };
  const articleContext = items.map((a, i) => ({ no: i + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', tags: (a.article_tags || []).map((x) => `${x.tag_type}:${x.tag_name}`), text: (a.ocr_text || '').slice(0, 4200) }));
  const system = [
    'あなたは生活者理解に熟達したプロのマーケターです。回答は必ずJSONです。',
    '目的は、MJ記事群から生活者の態度・行動・価値観の変化を読み、マーケターが納得する洞察に整理することです。ニュース要約ではなく、生活者動向レポートにしてください。',
    withMethod ? '今回は調査設計への落とし込みも求められています。ただし本文の主役は生活者動向です。手法適性は後段に分けてください。' : '今回は調査手法提案をしないでください。手法名や適性評価は、ユーザーが明示していない限り出さないでください。',
    '重要主張は必ず根拠記事IDに接続してください。記事にない内容は断定しない。弱い推論は limitations または rejected_connections に分ける。',
    strict && ind ? `対象業界は「${ind.label}」。本文や見出しに直接該当する記事だけを根拠にする。周辺テーマを類推接続しない。` : '',
    templateInstruction(t, withMethod),
    '必須JSON: report_title, answer_text, executive_summary, source_coverage, consumer_trend_narrative, key_findings, consumer_insights, behavior_shifts, tension_map, market_implications, evidence, table, cards, limitations, rejected_connections, next_questions, quality_score。' + (withMethod ? ' research_opportunities と method_fit も追加。' : ' research_opportunities と method_fit は出さない。'),
    'answer_textは、結論、生活者動向のナラティブ、根拠、マーケティング示唆、限界を見出し付きで書く。日本語で、浅い一般論は避ける。'
  ].filter(Boolean).join('\n');
  try {
    const completion = await openai.chat.completions.create({ model, temperature: 0.15, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...turns, { role: 'user', content: JSON.stringify({ user_query: q, target_scope: s, output_template: t, industry_filter: meta.industry_filter, method_layer: withMethod, article_count: articleContext.length, articles: articleContext }, null, 2) }] });
    const raw = completion.choices[0]?.message.content || '{}';
    const parsed = JSON.parse(raw);
    return { report_title: typeof parsed.report_title === 'string' ? parsed.report_title : q.slice(0, 50), answer_text: typeof parsed.answer_text === 'string' ? parsed.answer_text : raw, executive_summary: safeArray(parsed.executive_summary), source_coverage: parsed.source_coverage || { article_count: items.length, coverage_note: '対象記事から分析' }, consumer_trend_narrative: typeof parsed.consumer_trend_narrative === 'string' ? parsed.consumer_trend_narrative : '', key_findings: safeArray(parsed.key_findings), consumer_insights: safeArray(parsed.consumer_insights), behavior_shifts: safeArray(parsed.behavior_shifts), tension_map: safeArray(parsed.tension_map), market_implications: safeArray(parsed.market_implications), limitations: safeArray(parsed.limitations), rejected_connections: safeArray(parsed.rejected_connections), next_questions: safeArray(parsed.next_questions), ...(withMethod ? { research_opportunities: safeArray(parsed.research_opportunities), method_fit: safeArray(parsed.method_fit) } : {}), quality_score: parsed.quality_score || { evidence_strength: 3, consumer_understanding: 3, strategic_usefulness: 3, originality: 3, overall: 3, reason: '自己採点なし' }, table: Array.isArray(parsed.table) ? parsed.table : [], cards: Array.isArray(parsed.cards) ? parsed.cards : fallbackCards, insights: Array.isArray(parsed.insights) ? parsed.insights : [], ...parsed, evidence: evidence(parsed.evidence, items, q), ...meta };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI analysis failed';
    return { report_title: '分析エラー', answer_text: `OpenAI分析でエラーが出ました。該当記事${items.length}件は取得できています。エラー: ${message}`, table: [], cards: fallbackCards, evidence: evidence([], items, q), insights: [], ...emptyPayload(model, s, t, ind, strict, items.length, withMethod), ...meta };
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
    const retrieval = await retrieve(q, targetScope);
    const answer = await analyze(q, retrieval.articles, model, targetScope, outputTemplate, conversation(body.conversation), retrieval.industry, retrieval.strictIndustry);
    let report = null;
    let report_error = '';
    try {
      const { data, error } = await supabaseAdmin.from('chat_reports').insert({ user_query: q, answer_text: answer.answer_text, answer_json: answer, related_article_ids: retrieval.articles.map((a) => a.id) }).select('*').single();
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

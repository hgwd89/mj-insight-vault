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

const REPORT_JSON_CONTRACT = `
必ず次のJSON構造で返す。
{
  "report_title": "短く鋭いレポート名",
  "answer_text": "そのまま読める本文。結論、根拠、示唆、限界、次アクションを含める。",
  "executive_summary": ["重要結論を3-5点"],
  "key_findings": [{"title":"発見名","finding":"記事から言えること","why_it_matters":"なぜ重要か","evidence_article_ids":["記事ID"],"confidence":"high|medium|low"}],
  "consumer_insights": [{"insight":"生活者インサイト","behavior_change":"行動変化","why_now":"なぜ今か","business_implication":"企業示唆","evidence_article_ids":["記事ID"],"confidence":"high|medium|low"}],
  "tension_map": [{"surface_fact":"表層事実","underlying_tension":"背後の葛藤・未充足","evidence_article_ids":["記事ID"]}],
  "research_opportunities": [{"theme":"調査テーマ","research_question":"問い","hypothesis":"検証仮説","recommended_method":"N1探索|ビジュアル投影|BOT調査|リフレクション|定量調査|その他","sample_target":"対象者条件","trigger_articles":["記事ID"]}],
  "method_fit": [{"method":"手法名","fit_score":1-5,"why":"向く理由","suited_questions":["聞くべき問い"]}],
  "evidence": [{"insight":"示唆","claim":"主張","article_id":"記事ID","headline":"見出し","article_date":"日付","excerpt":"根拠抜粋","confidence":"high|medium|low"}],
  "table": [任意の整理表],
  "cards": [{"article_id":"記事ID","headline":"見出し","article_date":"日付","reason":"なぜ根拠か","confidence":"high|medium|low"}],
  "limitations": ["記事からは断定できないこと"],
  "rejected_connections": ["根拠が弱いため採用しなかった接続・推論"],
  "next_actions": ["次にやるべきこと"],
  "quality_score": {"evidence_strength":1-5,"strategic_usefulness":1-5,"originality":1-5,"actionability":1-5,"overall":1-5,"reason":"自己採点理由"}
}`;

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
  if (t === 'trend') return '生活者トレンドとして、変化の兆し、背景、生活者心理、企業示唆、調査仮説を分ける。単なるニュース要約で止めない。';
  if (t === 'why') return 'WHYを最低5段階で掘り下げる。各段階で、記事根拠から言えることと仮説を分ける。';
  if (t === 'research') return '調査目的、検証仮説、対象者条件、聞くべき論点、適した手法、定量化する項目まで落とす。';
  if (t === 'proposal') return '提案タイトル、クライアント課題、記事根拠、提案骨子、勝ち筋、想定反論を出す。';
  if (t === 'method') return 'N1探索、投影、BOT、リフレクション、定量の適性を比較し、なぜその手法かを記事根拠付きで評価する。';
  if (t === 'news_list') return '記事ごとに日付、見出し、主要事実、生活者変化、使い道を表形式で出す。';
  return '質問内容に合う形式で、実務で使える分析にする。';
}
function excerpt(a: ArticleContext, query: string) {
  const text = a.ocr_text || '';
  const hit = keywords(query).find((k) => text.includes(k));
  if (!hit) return text.slice(0, 220);
  return text.slice(Math.max(0, text.indexOf(hit) - 80), Math.max(0, text.indexOf(hit) - 80) + 260);
}
function cards(articles: ArticleContext[]) {
  return articles.slice(0, 12).map((a) => ({ article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', reason: '直接該当記事', confidence: a.article_date ? 'medium' : 'low' }));
}
function evidence(value: unknown, articles: ArticleContext[], query: string): EvidenceItem[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const raw = Array.isArray(value) ? value : [];
  const normalized: EvidenceItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as EvidenceItem;
    const a = r.article_id ? byId.get(r.article_id) : undefined;
    if (!a) continue;
    normalized.push({ insight: String(r.insight || r.claim || '').slice(0, 260), claim: String(r.claim || r.insight || '').slice(0, 260), article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', excerpt: String(r.excerpt || excerpt(a, query)).slice(0, 300), confidence: r.confidence || 'medium' });
  }
  return normalized.length ? normalized.slice(0, 24) : articles.slice(0, 10).map((a) => ({ insight: '直接該当記事', claim: '根拠として参照', article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', excerpt: excerpt(a, query), confidence: 'medium' }));
}
function noIndustryMessage(query: string, industry: Industry, targetScope: TargetScope) {
  return `${industry.label}として直接扱える記事が指定範囲に見つかりませんでした。\n周辺トピックを無理に接続せず、直接該当記事がある場合だけ分析します。\n検索条件: ${query}\n対象範囲: ${targetScope}`;
}
function emptyQuality(model: string, targetScope: TargetScope, outputTemplate: OutputTemplate, industry: Industry | null, strictIndustry: boolean, articleCount: number) {
  return {
    executive_summary: [], key_findings: [], consumer_insights: [], tension_map: [], research_opportunities: [], method_fit: [], limitations: ['分析対象の記事が不足しています。'], rejected_connections: [], next_actions: ['該当記事を追加する', '分析対象範囲を見直す'],
    quality_score: { evidence_strength: articleCount ? 2 : 1, strategic_usefulness: 1, originality: 1, actionability: 2, overall: 1, reason: '根拠記事が不足しているため高品質レポート化できません。' },
    industry_filter: industry ? { key: industry.key, label: industry.label, strict: strictIndustry } : null, target_scope: targetScope, output_template: outputTemplate, model_used: model, related_article_count: articleCount
  };
}
function safeArray(value: unknown) { return Array.isArray(value) ? value : []; }
async function analyze(query: string, articles: ArticleContext[], model: string, targetScope: TargetScope, outputTemplate: OutputTemplate, conversation: ConversationTurn[], industry: Industry | null, strictIndustry: boolean) {
  const openai = getOpenAI();
  const baseMeta = { industry_filter: industry ? { key: industry.key, label: industry.label, strict: strictIndustry } : null, target_scope: targetScope, output_template: outputTemplate, model_used: model, related_article_count: articles.length };
  if (!articles.length) return { report_title: '該当記事なし', answer_text: industry && strictIndustry ? noIndustryMessage(query, industry, targetScope) : '指定範囲に分析対象の記事がありません。', table: [], cards: [], evidence: [], insights: [], ...emptyQuality(model, targetScope, outputTemplate, industry, strictIndustry, 0) };
  const fallbackCards = cards(articles);
  if (!openai) return { report_title: '該当記事一覧', answer_text: `OPENAI_API_KEYが未設定のため、該当記事${articles.length}件のみ返します。`, table: [], cards: fallbackCards, evidence: evidence([], articles, query), insights: [], ...emptyQuality(model, targetScope, outputTemplate, industry, strictIndustry, articles.length), ...baseMeta };

  const articleContext = articles.map((a, i) => ({ no: i + 1, article_id: a.id, headline: a.headline, article_date: a.article_date || '日付不明', tags: (a.article_tags || []).map((t) => `${t.tag_type}:${t.tag_name}`), text: (a.ocr_text || '').slice(0, 4200) }));
  const system = [
    'あなたはマーケティングリサーチの上級コンサルタントです。回答は必ずJSONです。',
    '品質基準は、ソース接地型QAの根拠明示、リサーチ支援ツールのエビデンス評価、戦略コンサル資料の示唆構造を統合したものです。表面要約ではなく、意思決定に使えるレポートにしてください。',
    '禁止事項: 記事にない事実の断定、周辺トピックの強引な接続、根拠IDなしの重要主張、一般論の水増し、無意味な「今後期待される」。',
    '各重要主張は必ず evidence_article_ids または article_id で根拠記事に接続してください。根拠が弱い場合は confidence を low にし、limitations または rejected_connections に明記してください。',
    strictIndustry && industry ? `対象業界は「${industry.label}」。記事本文や見出しに直接該当する記事だけを根拠にしてください。周辺テーマを業界へ類推接続しないでください。該当記事が少ない場合は限定的と明記してください。` : '',
    'N1探索に向く場合は、少数だが濃い工夫・逸脱使用・独自のやりくりから商品仮説へ落としてください。',
    '投影法に向く場合は、直接聞くと平板化する論点、感情の質感、比喩、葛藤、社会的望ましさの回避を明記してください。',
    'BOT調査に向く場合は、対話で回答が深まる余地、聞き返しポイント、会話ログから抽出する変数を明記してください。',
    'リフレクションに向く場合は、対象者の語り直し、意味づけの更新、観察者コメントで起きる視点転換を明記してください。',
    templateInstruction(outputTemplate),
    REPORT_JSON_CONTRACT,
    'answer_textは、見出し付きの読み物として成立させてください。最初に結論、その後に根拠、読み解き、示唆、調査化、限界を書く。',
    '日本語で、断定と仮説を明確に分け、実務でそのまま使える粒度にしてください。'
  ].filter(Boolean).join('\n');

  try {
    const completion = await openai.chat.completions.create({ model, temperature: 0.15, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, ...conversation, { role: 'user', content: JSON.stringify({ user_query: query, target_scope: targetScope, output_template: outputTemplate, industry_filter: baseMeta.industry_filter, article_count: articleContext.length, articles: articleContext }, null, 2) }] });
    const raw = completion.choices[0]?.message.content || '{}';
    try {
      const parsed = JSON.parse(raw);
      const normalizedEvidence = evidence(parsed.evidence, articles, query);
      return {
        report_title: typeof parsed.report_title === 'string' ? parsed.report_title : query.slice(0, 50),
        answer_text: typeof parsed.answer_text === 'string' ? parsed.answer_text : typeof parsed.summary === 'string' ? parsed.summary : raw,
        executive_summary: safeArray(parsed.executive_summary),
        key_findings: safeArray(parsed.key_findings),
        consumer_insights: safeArray(parsed.consumer_insights),
        tension_map: safeArray(parsed.tension_map),
        research_opportunities: safeArray(parsed.research_opportunities),
        method_fit: safeArray(parsed.method_fit),
        limitations: safeArray(parsed.limitations),
        rejected_connections: safeArray(parsed.rejected_connections),
        next_actions: safeArray(parsed.next_actions),
        quality_score: parsed.quality_score || { evidence_strength: 3, strategic_usefulness: 3, originality: 3, actionability: 3, overall: 3, reason: 'モデル出力に自己採点がありません。' },
        table: Array.isArray(parsed.table) ? parsed.table : [],
        cards: Array.isArray(parsed.cards) ? parsed.cards : fallbackCards,
        insights: Array.isArray(parsed.insights) ? parsed.insights : [],
        ...parsed,
        evidence: normalizedEvidence,
        ...baseMeta
      };
    } catch {
      return { report_title: query.slice(0, 50), answer_text: raw, table: [], cards: fallbackCards, evidence: evidence([], articles, query), insights: [], ...emptyQuality(model, targetScope, outputTemplate, industry, strictIndustry, articles.length), ...baseMeta };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI analysis failed';
    return { report_title: '分析エラー', answer_text: `OpenAI分析でエラーが出ました。該当記事${articles.length}件は取得できています。エラー: ${message}`, table: [], cards: fallbackCards, evidence: evidence([], articles, query), insights: [], ...emptyQuality(model, targetScope, outputTemplate, industry, strictIndustry, articles.length), ...baseMeta };
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

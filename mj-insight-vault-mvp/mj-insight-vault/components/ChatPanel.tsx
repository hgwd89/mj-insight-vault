'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MarkdownArticleText } from '@/components/MarkdownArticleText';
import { useAppPassword } from '@/components/PasswordGate';

const presets = [
  '今月分を分析して',
  '食品業界だけ分析して',
  '化粧品業界だけ分析して',
  'AI関連の記事を分析して',
  '調査が必要そうな論点を優先度順に出して',
  '説明仮説を複数案で比較して',
  '根拠マトリクス付きで整理して',
  '反証・別解釈まで出して',
  '元記事に戻れる形で出して',
  'この記事に似た記事を探して'
];

const modelOptions = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'] as const;

const targetScopes = [
  { value: 'all', label: '全記事', description: '不要記事を除く全記事から検索。' },
  { value: 'recent_30d', label: '直近30日', description: '直近30日の記事だけから検索。' },
  { value: 'latest_batch', label: '最新アップロード', description: '最新アップロード分だけから検索。' }
] as const;

const outputTemplates = [
  { value: 'auto', label: '自動', description: '質問内容に合わせて出力形式を調整。' },
  { value: 'trend', label: '生活者トレンド', description: '生活者変化・背景・示唆を中心に整理。' },
  { value: 'why', label: 'WHY深掘り', description: 'WHYを3回重ねて背後欲求まで掘る。' },
  { value: 'research', label: 'リサーチ課題化', description: '調査が必要そうな論点・検証仮説へ落とす。' },
  { value: 'proposal', label: '提案書ネタ', description: '提案に使えるリサーチテーマとして整理。' },
  { value: 'method', label: '手法適性', description: '明示的に必要な場合だけ手法適性を見る。' },
  { value: 'news_list', label: 'ニュース一覧', description: '元記事を一覧として確認する。' }
] as const;

type ModelName = typeof modelOptions[number];
type TargetScope = typeof targetScopes[number]['value'];
type OutputTemplate = typeof outputTemplates[number]['value'];

type ArticleCard = {
  article_id?: string;
  headline?: string;
  article_date?: string;
  evidence_excerpt?: string;
  confidence?: string;
  reason?: string;
  note?: string;
};

type RelatedArticle = {
  id: string;
  headline?: string | null;
  article_date?: string | null;
  ocr_text?: string | null;
};

type WhyChainItem = {
  level?: number;
  why?: string;
  explanation?: string;
  evidence_article_ids?: string[];
};

type ExplanatoryHypothesis = {
  hypothesis?: string;
  observed_facts?: string[];
  underlying_motive?: string;
  mechanism?: string;
  alternative_read?: string;
  marketing_implication?: string;
  research_implication?: string;
  evidence_article_ids?: string[];
  confidence?: string;
  why_chain?: WhyChainItem[];
  why_1?: string;
  why_2?: string;
  why_3?: string;
};

type ResearchNeed = {
  theme?: string;
  why_research_needed?: string;
  unknowns?: string[];
  hypothesis_to_test?: string;
  research_question?: string;
  signals_from_articles?: string[];
  evidence_article_ids?: string[];
  priority?: string;
  score?: number | string;
  confidence?: string;
};

type EvidenceMatrixRow = {
  claim?: string;
  insight?: string;
  article_id?: string;
  headline?: string;
  article_date?: string;
  article_url?: string;
  article_link?: string;
  evidence_excerpt?: string;
  excerpt?: string;
  supports?: string;
  strength?: string;
  limitation?: string;
  research_need?: string;
  confidence?: string;
};

type HypothesisOption = {
  hypothesis?: string;
  support?: string;
  evidence_article_ids?: string[];
  what_would_disprove?: string;
  research_question?: string;
  confidence?: string;
};

type HypothesisComparison = {
  phenomenon?: string;
  best_current_read?: string;
  hypotheses?: HypothesisOption[];
};

type CoverageDiagnosis = {
  article_count?: number;
  direct_article_count?: number;
  peripheral_article_count?: number;
  date_unknown_count?: number;
  coverage_note?: string;
  caveats?: string[];
};

type QualityRubric = {
  evidence_strength?: number | string;
  hypothesis_depth?: number | string;
  research_potential?: number | string;
  restraint?: number | string;
  originality?: number | string;
  overall?: number | string;
  reason?: string;
};

type KeyFinding = {
  title?: string;
  finding?: string;
  why_it_matters?: string;
};

type ChatAnswer = {
  answer_text?: string;
  summary?: string;
  executive_summary?: string[];
  consumer_trend_narrative?: string;
  key_findings?: KeyFinding[];
  table?: Record<string, unknown>[];
  cards?: ArticleCard[];
  evidence?: EvidenceMatrixRow[];
  evidence_matrix?: EvidenceMatrixRow[];
  explanatory_hypotheses?: ExplanatoryHypothesis[];
  research_needs?: ResearchNeed[];
  hypothesis_comparison?: HypothesisComparison[];
  coverage_diagnosis?: CoverageDiagnosis;
  source_coverage?: CoverageDiagnosis;
  quality_rubric?: QualityRubric;
  quality_score?: QualityRubric;
  target_scope?: string;
  output_template?: string;
  model_used?: string;
  requested_model?: string;
  analysis_mode?: string;
  model_policy?: string;
  related_article_count?: number;
  [key: string]: unknown;
};

type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type SavedReportLink = {
  id: string;
  title?: string;
};

function str(value: unknown) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function modelLabel(model: ModelName) {
  const labels: Record<ModelName, string> = {
    'gpt-5': 'gpt-5｜本気レポート・高品質分析',
    'gpt-5-mini': 'gpt-5-mini｜通常分析・軽めの傾向確認',
    'gpt-5-nano': 'gpt-5-nano｜速報・粗い傾向確認',
    'gpt-4.1': 'gpt-4.1｜旧標準',
    'gpt-4.1-mini': 'gpt-4.1-mini｜旧軽量',
    'gpt-4o': 'gpt-4o｜旧高品質',
    'gpt-4o-mini': 'gpt-4o-mini｜旧軽量'
  };
  return labels[model];
}

function getField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = str(row[key]);
    if (value) return value;
  }
  return '';
}

function splitIds(value: unknown) {
  return str(value).split(/[、,\s]+/).map((id) => id.trim()).filter(Boolean);
}

function isUsefulCard(card: ArticleCard) {
  return Boolean(str(card.headline) || str(card.article_id) || str(card.evidence_excerpt) || str(card.reason) || str(card.note));
}

function getWhyChain(h: ExplanatoryHypothesis): WhyChainItem[] {
  if (Array.isArray(h.why_chain) && h.why_chain.some((w) => str(w.why) || str(w.explanation))) {
    return h.why_chain.filter((w) => str(w.why) || str(w.explanation)).slice(0, 3);
  }

  return [h.why_1, h.why_2, h.why_3]
    .map((why, index) => why ? { level: index + 1, why, explanation: why } : null)
    .filter(Boolean) as WhyChainItem[];
}

function isUsefulHypothesis(h: ExplanatoryHypothesis) {
  return Boolean(str(h.hypothesis) || str(h.underlying_motive) || str(h.mechanism) || str(h.alternative_read) || str(h.research_implication) || str(h.marketing_implication) || getWhyChain(h).length);
}

function isUsefulResearchNeed(need: ResearchNeed) {
  return Boolean(str(need.theme) || str(need.why_research_needed) || str(need.hypothesis_to_test) || str(need.research_question) || (need.unknowns || []).some(str) || (need.signals_from_articles || []).some(str));
}

function isUsefulEvidence(row: EvidenceMatrixRow) {
  return Boolean(str(row.claim) || str(row.insight) || str(row.article_id) || str(row.headline) || str(row.evidence_excerpt) || str(row.excerpt) || str(row.supports) || str(row.limitation) || str(row.research_need));
}

function evidenceFromTable(table?: Record<string, unknown>[]): EvidenceMatrixRow[] {
  if (!Array.isArray(table)) return [];

  return table.map((row) => ({
    claim: getField(row, ['主張', '論点', 'インサイト', '仮説', 'テーマ']),
    article_id: getField(row, ['根拠記事ID', '根拠記事', '関連記事ID', '記事ID']),
    headline: getField(row, ['見出し', '記事', '根拠記事名']),
    evidence_excerpt: getField(row, ['該当抜粋', '根拠抜粋', '記事からの兆し', '根拠']),
    strength: getField(row, ['根拠強度', '強度', 'confidence', '確信度']),
    limitation: getField(row, ['限界', '未解明な点', '留意点']),
    research_need: getField(row, ['調査が必要な理由', '調査論点', 'リサーチ課題'])
  })).filter(isUsefulEvidence);
}

function researchNeedsFromTable(table?: Record<string, unknown>[]): ResearchNeed[] {
  if (!Array.isArray(table)) return [];

  return table.map((row) => ({
    theme: getField(row, ['調査論点', '主張', '論点', 'テーマ', 'インサイト']),
    why_research_needed: getField(row, ['調査が必要な理由', 'リサーチ課題', '限界']),
    hypothesis_to_test: getField(row, ['検証仮説', '仮説', '主張']),
    signals_from_articles: [getField(row, ['該当抜粋', '根拠抜粋', '記事からの兆し', '根拠'])].filter(Boolean),
    evidence_article_ids: splitIds(getField(row, ['根拠記事ID', '根拠記事', '関連記事ID', '記事ID'])),
    priority: getField(row, ['優先度', 'priority']),
    confidence: getField(row, ['確信度', 'confidence', '根拠強度'])
  })).filter(isUsefulResearchNeed);
}

function getAnswerText(answer: ChatAnswer): string {
  if (typeof answer.answer_text === 'string' && answer.answer_text.trim()) return answer.answer_text;
  if (typeof answer.summary === 'string' && answer.summary.trim()) return answer.summary;

  const lines: string[] = [];
  const executive = Array.isArray(answer.executive_summary) ? answer.executive_summary.filter(Boolean) : [];
  if (executive.length) {
    lines.push('## 要旨', ...executive.map((x) => `- ${x}`), '');
  }

  if (typeof answer.consumer_trend_narrative === 'string' && answer.consumer_trend_narrative.trim()) {
    lines.push('## 生活者動向のナラティブ', answer.consumer_trend_narrative.trim(), '');
  }

  if (Array.isArray(answer.key_findings) && answer.key_findings.length) {
    const findings = answer.key_findings
      .map((finding) => [finding.title, finding.finding, finding.why_it_matters].map(str).filter(Boolean).join('：'))
      .filter(Boolean);
    if (findings.length) lines.push('## 主要な読み', ...findings.map((x) => `- ${x}`), '');
  }

  const needs = Array.isArray(answer.research_needs) ? answer.research_needs.filter(isUsefulResearchNeed) : researchNeedsFromTable(answer.table);
  if (needs.length) {
    lines.push('## 調査が必要そうな論点', ...needs.slice(0, 5).map((need, index) => `- ${index + 1}. ${need.theme || need.research_question || need.hypothesis_to_test || '調査論点'}${need.why_research_needed ? `：${need.why_research_needed}` : ''}`));
  }

  return lines.join('\n').trim();
}

function evidenceExcerpt(text?: string | null) {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  return compact.length > 220 ? `${compact.slice(0, 220)}...` : compact;
}

function buildReportQuery(userQuery: string) {
  return `${userQuery}\n\n【レポート要件】\n目的は、MJ記事群からリサーチのネタを発見することです。商品開発・販促・チャネルなどの実行アクション提案は不要です。\n\n最重要: answer_text は必須です。空欄にしないでください。answer_text には、少なくとも「結論」「生活者動向のナラティブ」「説明仮説（WHY3段階）」「調査が必要そうな論点」「根拠と限界」を本文として書いてください。\n空のオブジェクト、空の見出し、値が入っていない配列要素は禁止です。値を埋められない項目は出力しないでください。\n\n必ず以下を出してください。\n1. カバレッジ診断: 対象記事数、直接該当/周辺該当、日付不明、記事群の偏り、言える範囲。JSONでは coverage_diagnosis または source_coverage。\n2. 説明仮説（インサイト）: なぜその生活者行動が起きているのか。WHYを必ず3回重ねる。WHY1=表層行動の理由、WHY2=背後心理・制約、WHY3=価値観・社会背景。JSONでは explanatory_hypotheses と why_chain。\n3. 説明仮説の複数案比較: 1つの現象に対して複数の読みを並べ、どれが現時点で有力か、どれは調査で確認すべきかを分ける。JSONでは hypothesis_comparison。\n4. 調査が必要そうな論点ランキング: なぜ調査が必要か、未解明な点、検証仮説、記事からの兆し、根拠記事ID、優先度、確信度、可能ならスコア。JSONでは research_needs。theme, why_research_needed, hypothesis_to_test, evidence_article_ids は必ず埋める。\n5. 根拠マトリクス: 主張、根拠記事、該当抜粋、根拠強度、限界、調査が必要な理由を表で出す。JSONでは evidence_matrix。claim, article_id, evidence_excerpt, strength, limitation, research_need は必ず埋める。\n6. 反証・別解釈: この読みが外れる可能性、棄却条件、追加で必要なデータ。\n7. 品質ルーブリック: 根拠強度、仮説の深さ、調査余地、無理な接続の少なさ、発見性を自己評価。JSONでは quality_rubric または quality_score。\n\n重要: 記事にないことを断定しないでください。弱い推論は「仮説」「未検証」「調査が必要」と明記してください。根拠記事IDのない重要主張は禁止です。`;
}

function scoreValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function articleHrefFromEvidence(row: EvidenceMatrixRow) {
  const articleId = str(row.article_id);
  if (articleId) return `/articles/${articleId}`;
  const articleUrl = str(row.article_url);
  return articleUrl.startsWith('/articles/') ? articleUrl : '';
}

export function ChatPanel() {
  const password = useAppPassword();
  const [query, setQuery] = useState('');
  const [model, setModel] = useState<ModelName>('gpt-5');
  const [targetScope, setTargetScope] = useState<TargetScope>('all');
  const [outputTemplate, setOutputTemplate] = useState<OutputTemplate>('auto');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [raw, setRaw] = useState('');
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [relatedArticles, setRelatedArticles] = useState<RelatedArticle[]>([]);
  const [savedReport, setSavedReport] = useState<SavedReportLink | null>(null);
  const [showPresets, setShowPresets] = useState(false);

  const selectedScope = targetScopes.find((scope) => scope.value === targetScope) || targetScopes[0];
  const selectedTemplate = outputTemplates.find((template) => template.value === outputTemplate) || outputTemplates[0];

  async function send(q = query) {
    const trimmed = q.trim();
    if (!trimmed) return;

    setBusy(true);
    setRaw('');

    const userTurn: ConversationTurn = { role: 'user', content: trimmed };
    const nextConversation: ConversationTurn[] = [...conversation, userTurn];

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          query: buildReportQuery(trimmed),
          model,
          target_scope: targetScope,
          output_template: outputTemplate,
          conversation
        })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Chat failed');

      const nextAnswer = json.answer as ChatAnswer;
      const answerText = getAnswerText(nextAnswer);
      const assistantTurn: ConversationTurn = { role: 'assistant', content: answerText || JSON.stringify(nextAnswer) };
      const reportId = typeof json.report?.id === 'string' ? json.report.id : '';
      const reportTitle = typeof json.report?.answer_json?.report_title === 'string'
        ? json.report.answer_json.report_title
        : typeof nextAnswer.report_title === 'string'
          ? nextAnswer.report_title
          : '';

      setAnswer(nextAnswer);
      setSavedReport(reportId ? { id: reportId, title: reportTitle } : null);
      setRelatedArticles(Array.isArray(json.related_articles) ? json.related_articles : []);
      setRaw(JSON.stringify(json, null, 2));
      setConversation([...nextConversation, assistantTurn].slice(-10));
      setQuery('');
    } catch (error) {
      setRaw(error instanceof Error ? error.message : 'エラーが発生しました');
      setConversation(conversation);
    } finally {
      setBusy(false);
    }
  }

  function resetConversation() {
    setConversation([]);
    setAnswer(null);
    setSavedReport(null);
    setRaw('');
    setQuery('');
    setRelatedArticles([]);
  }

  const relatedById = new Map(relatedArticles.map((article) => [article.id, article]));
  const answerCards = Array.isArray(answer?.cards) ? answer.cards.filter(isUsefulCard) : [];
  const evidenceCards: ArticleCard[] = answerCards.length
    ? answerCards
    : relatedArticles.slice(0, 12).map((article) => ({
        article_id: article.id,
        headline: article.headline || '記事',
        article_date: article.article_date || '日付不明',
        evidence_excerpt: evidenceExcerpt(article.ocr_text),
        confidence: article.article_date ? 'medium' : 'low',
        reason: '検索で取得した根拠候補'
      }));

  const hypotheses = Array.isArray(answer?.explanatory_hypotheses) ? answer.explanatory_hypotheses.filter(isUsefulHypothesis) : [];
  const researchNeeds = Array.isArray(answer?.research_needs) && answer.research_needs.some(isUsefulResearchNeed)
    ? answer.research_needs.filter(isUsefulResearchNeed)
    : researchNeedsFromTable(answer?.table);
  const evidenceMatrixRaw = Array.isArray(answer?.evidence_matrix) && answer.evidence_matrix.some(isUsefulEvidence)
    ? answer.evidence_matrix
    : Array.isArray(answer?.evidence) && answer.evidence.some(isUsefulEvidence)
      ? answer.evidence
      : evidenceFromTable(answer?.table);
  const evidenceMatrix = evidenceMatrixRaw.filter(isUsefulEvidence);
  const comparisons = Array.isArray(answer?.hypothesis_comparison) ? answer.hypothesis_comparison : [];
  const coverage = answer?.coverage_diagnosis || answer?.source_coverage;
  const quality = answer?.quality_rubric || answer?.quality_score;
  const answerText = answer ? getAnswerText(answer) : '';

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-xl font-black">チャット分析</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              MJ記事から生活者動向を読み、説明仮説・根拠・調査が必要そうな論点を抽出します。
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn" type="button" onClick={resetConversation} disabled={busy}>会話リセット</button>
            <Link className="btn" href="/reports">分析履歴</Link>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="text-sm font-bold text-zinc-700">APIモデル</span>
            <select className="input mt-2" value={model} onChange={(e) => setModel(e.target.value as ModelName)} disabled={busy}>
              {modelOptions.map((m) => <option key={m} value={m}>{modelLabel(m)}</option>)}
            </select>
            <p className="mt-1 text-xs leading-5 text-zinc-500">本気レポートは gpt-5 推奨。軽く傾向を見る場合だけ mini / nano / 旧モデルを使います。</p>
          </label>

          <label className="block">
            <span className="text-sm font-bold text-zinc-700">分析対象</span>
            <select className="input mt-2" value={targetScope} onChange={(e) => setTargetScope(e.target.value as TargetScope)} disabled={busy}>
              {targetScopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
            </select>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{selectedScope.description}</p>
          </label>

          <label className="block">
            <span className="text-sm font-bold text-zinc-700">出力テンプレート</span>
            <select className="input mt-2" value={outputTemplate} onChange={(e) => setOutputTemplate(e.target.value as OutputTemplate)} disabled={busy}>
              {outputTemplates.map((template) => <option key={template.value} value={template.value}>{template.label}</option>)}
            </select>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{selectedTemplate.description}</p>
          </label>
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <button className="btn w-fit" type="button" onClick={() => setShowPresets((v) => !v)} disabled={busy}>
            {showPresets ? '定型指示を隠す' : '定型指示を表示'}
          </button>
          {showPresets && <div className="flex flex-wrap gap-2">{presets.map((p) => <button key={p} className="btn" onClick={() => { setQuery(p); send(p); }} disabled={busy}>{p}</button>)}</div>}
        </div>

        {conversation.length > 0 && <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">継続中の会話：{conversation.filter((turn) => turn.role === 'user').length}問</div>}

        <div className="mt-4 flex gap-2">
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={conversation.length ? 'この分析結果について追加質問' : '分析指示を入力'} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(); }} />
          <button className="btn btn-primary" onClick={() => send()} disabled={busy || !query.trim()}>{busy ? '分析中' : '送信'}</button>
        </div>
      </div>

      {answer && (
        <div className="card space-y-5 p-5">
          <section>
            <h2 className="font-bold">回答</h2>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {answer.target_scope && <span className="badge">scope: {answer.target_scope}</span>}
              {answer.output_template && <span className="badge">template: {answer.output_template}</span>}
              {answer.model_used && <span className="badge">model: {answer.model_used}</span>}
              {answer.analysis_mode && <span className="badge">mode: {answer.analysis_mode}</span>}
              {answer.model_policy && <span className="badge">{answer.model_policy}</span>}
              {typeof answer.related_article_count === 'number' && <span className="badge">記事 {answer.related_article_count}</span>}
            </div>
            {answerText ? <MarkdownArticleText text={answerText} articles={relatedArticles} className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700" /> : <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-800">本文が空で返っています。下の構造化セクションを表示しています。再実行すると本文も生成されます。</p>}
            {savedReport && (
              <div className="mt-4 flex flex-col gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 md:flex-row md:items-center md:justify-between">
                <span className="font-bold">保存済みレポート{savedReport.title ? `: ${savedReport.title}` : ''}</span>
                <Link className="btn bg-white" href={`/reports/${savedReport.id}`}>レポートを開く</Link>
              </div>
            )}
          </section>

          {coverage && (
            <section>
              <h2 className="mb-2 font-bold">カバレッジ診断</h2>
              <div className="grid gap-2 text-sm md:grid-cols-4">
                <div className="rounded-xl bg-zinc-50 p-3"><b>{coverage.article_count ?? answer.related_article_count ?? '-'}</b><br />対象記事</div>
                <div className="rounded-xl bg-zinc-50 p-3"><b>{coverage.direct_article_count ?? '-'}</b><br />直接該当</div>
                <div className="rounded-xl bg-zinc-50 p-3"><b>{coverage.peripheral_article_count ?? '-'}</b><br />周辺該当</div>
                <div className="rounded-xl bg-zinc-50 p-3"><b>{coverage.date_unknown_count ?? '-'}</b><br />日付不明</div>
              </div>
              {coverage.coverage_note && <p className="mt-3 text-sm leading-6 text-zinc-700">{coverage.coverage_note}</p>}
              {Array.isArray(coverage.caveats) && coverage.caveats.length > 0 && <p className="mt-2 text-sm leading-6 text-zinc-600">留意点：{coverage.caveats.join(' / ')}</p>}
            </section>
          )}

          {researchNeeds.length > 0 && (
            <section>
              <h2 className="mb-2 font-bold">調査が必要そうな論点ランキング</h2>
              <div className="grid gap-3">
                {researchNeeds.map((need, index) => (
                  <div key={index} className="rounded-xl border border-zinc-200 p-3 text-sm leading-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-zinc-900 px-2 py-1 text-xs font-bold text-white">#{index + 1}</span>
                      <p className="font-semibold">{need.theme || need.research_question || need.hypothesis_to_test || `調査論点 ${index + 1}`}</p>
                      {need.priority && <span className="badge">priority: {need.priority}</span>}
                      {need.score !== undefined && <span className="badge">score: {need.score}</span>}
                      {need.confidence && <span className="badge">confidence: {need.confidence}</span>}
                    </div>
                    {need.why_research_needed && <p className="mt-2 text-zinc-700"><b>調査が必要な理由：</b>{need.why_research_needed}</p>}
                    {(need.hypothesis_to_test || need.research_question) && <p className="mt-1 text-zinc-700"><b>検証仮説・問い：</b>{need.hypothesis_to_test || need.research_question}</p>}
                    {Array.isArray(need.unknowns) && need.unknowns.length > 0 && <p className="mt-1 text-zinc-700"><b>未解明な点：</b>{need.unknowns.join(' / ')}</p>}
                    {Array.isArray(need.signals_from_articles) && need.signals_from_articles.length > 0 && <p className="mt-1 text-zinc-700"><b>記事からの兆し：</b>{need.signals_from_articles.join(' / ')}</p>}
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">{(need.evidence_article_ids || []).map((id) => <span key={id} className="badge">記事 {id}</span>)}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {hypotheses.length > 0 && (
            <section>
              <h2 className="mb-2 font-bold">説明仮説（インサイト）</h2>
              <div className="grid gap-3">
                {hypotheses.map((h, index) => {
                  const whyChain = getWhyChain(h);
                  return (
                    <div key={index} className="rounded-xl border border-zinc-200 p-3 text-sm leading-6">
                      <p className="font-semibold">{h.hypothesis || `説明仮説 ${index + 1}`}</p>
                      {whyChain.length > 0 && (
                        <div className="mt-3 rounded-xl bg-zinc-50 p-3">
                          <p className="text-xs font-bold text-zinc-500">WHY 3段階</p>
                          <div className="mt-2 grid gap-2">
                            {whyChain.map((w, wi) => (
                              <div key={wi} className="rounded-lg border border-zinc-200 bg-white p-2">
                                <p className="text-xs font-bold text-zinc-500">WHY {w.level || wi + 1}</p>
                                {w.why && <p className="mt-1 font-semibold text-zinc-800">{w.why}</p>}
                                {w.explanation && w.explanation !== w.why && <p className="mt-1 text-zinc-700">{w.explanation}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {h.underlying_motive && <p className="mt-2 text-zinc-700"><b>背後心理：</b>{h.underlying_motive}</p>}
                      {h.mechanism && <p className="mt-1 text-zinc-700"><b>発生メカニズム：</b>{h.mechanism}</p>}
                      {h.alternative_read && <p className="mt-1 text-zinc-700"><b>別解釈：</b>{h.alternative_read}</p>}
                      {(h.research_implication || h.marketing_implication) && <p className="mt-1 text-zinc-700"><b>リサーチ上の意味：</b>{h.research_implication || h.marketing_implication}</p>}
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        {h.confidence && <span className="badge">confidence: {h.confidence}</span>}
                        {(h.evidence_article_ids || []).map((id) => <span key={id} className="badge">記事 {id}</span>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {comparisons.length > 0 && (
            <section>
              <h2 className="mb-2 font-bold">説明仮説の複数案比較</h2>
              <div className="grid gap-3">
                {comparisons.map((comparison, index) => (
                  <div key={index} className="rounded-xl border border-zinc-200 p-3 text-sm leading-6">
                    <p className="font-semibold">{comparison.phenomenon || `比較対象 ${index + 1}`}</p>
                    {comparison.best_current_read && <p className="mt-1 text-zinc-700"><b>現時点の有力読み：</b>{comparison.best_current_read}</p>}
                    {Array.isArray(comparison.hypotheses) && comparison.hypotheses.length > 0 && (
                      <div className="mt-3 grid gap-2">
                        {comparison.hypotheses.map((h, i) => (
                          <div key={i} className="rounded-lg bg-zinc-50 p-3">
                            <p className="font-semibold">仮説{i + 1}: {h.hypothesis || '-'}</p>
                            {h.support && <p className="mt-1">根拠: {h.support}</p>}
                            {h.what_would_disprove && <p className="mt-1">棄却条件: {h.what_would_disprove}</p>}
                            {h.research_question && <p className="mt-1">調査問い: {h.research_question}</p>}
                            <div className="mt-2 flex flex-wrap gap-2 text-xs">
                              {h.confidence && <span className="badge">confidence: {h.confidence}</span>}
                              {(h.evidence_article_ids || []).map((id) => <span key={id} className="badge">記事 {id}</span>)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {evidenceMatrix.length > 0 && (
            <section className="overflow-x-auto">
              <h2 className="mb-2 font-bold">根拠マトリクス</h2>
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr>
                    {['主張', '記事', '根拠抜粋', '強度', '限界', '調査が必要な理由'].map((h) => <th key={h} className="border-b bg-zinc-50 p-2 text-left">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {evidenceMatrix.map((row, index) => {
                    const href = articleHrefFromEvidence(row);
                    return (
                      <tr key={index}>
                        <td className="border-b p-2 align-top">{row.claim || row.insight || '-'}</td>
                        <td className="border-b p-2 align-top">
                          {row.article_date || '日付不明'}<br />
                          {href
                            ? <Link href={href} className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900">{row.headline || row.article_id || '記事詳細'}</Link>
                            : row.headline || row.article_id || '-'}
                        </td>
                        <td className="border-b p-2 align-top">{row.evidence_excerpt || row.excerpt || row.supports || '-'}</td>
                        <td className="border-b p-2 align-top">{row.strength || row.confidence || '-'}</td>
                        <td className="border-b p-2 align-top">{row.limitation || '-'}</td>
                        <td className="border-b p-2 align-top">{row.research_need || '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {quality && (
            <section>
              <h2 className="mb-2 font-bold">品質ルーブリック</h2>
              <div className="grid gap-2 text-sm md:grid-cols-5">
                <div className="rounded-xl bg-zinc-50 p-3"><b>{scoreValue(quality.evidence_strength)}</b><br />根拠強度</div>
                <div className="rounded-xl bg-zinc-50 p-3"><b>{scoreValue(quality.hypothesis_depth)}</b><br />仮説の深さ</div>
                <div className="rounded-xl bg-zinc-50 p-3"><b>{scoreValue(quality.research_potential)}</b><br />調査余地</div>
                <div className="rounded-xl bg-zinc-50 p-3"><b>{scoreValue(quality.restraint)}</b><br />無理な接続の少なさ</div>
                <div className="rounded-xl bg-zinc-50 p-3"><b>{scoreValue(quality.overall)}</b><br />総合</div>
              </div>
              {quality.reason && <p className="mt-3 text-sm leading-6 text-zinc-700">{quality.reason}</p>}
            </section>
          )}

          {Array.isArray(answer.table) && answer.table.length > 0 && (
            <section className="overflow-x-auto">
              <h2 className="mb-2 font-bold">整理表</h2>
              <table className="w-full min-w-[720px] text-sm">
                <thead><tr>{Object.keys(answer.table[0]).map((k) => <th key={k} className="border-b bg-zinc-50 p-2 text-left">{k}</th>)}</tr></thead>
                <tbody>{answer.table.map((row, i) => <tr key={i}>{Object.entries(row).map(([k, v]) => <td key={k} className="border-b p-2 align-top">{String(v ?? '')}</td>)}</tr>)}</tbody>
              </table>
            </section>
          )}

          {evidenceCards.length > 0 && (
            <section>
              <h2 className="mb-2 font-bold">根拠記事カード</h2>
              <div className="grid gap-3">
                {evidenceCards.map((c, i) => {
                  const related = c.article_id ? relatedById.get(c.article_id) : undefined;
                  const date = c.article_date || related?.article_date || '日付不明';
                  const excerpt = c.evidence_excerpt || evidenceExcerpt(related?.ocr_text);
                  return (
                    <div key={`${c.article_id || 'card'}-${i}`} className="rounded-xl border border-zinc-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{c.headline || related?.headline || c.article_id || '記事'}</p>
                        <span className="badge">{date}</span>
                        {c.confidence && <span className="badge">confidence: {c.confidence}</span>}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-zinc-600">{c.reason || c.note || '根拠候補'}</p>
                      {excerpt && <p className="mt-2 rounded-xl bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">{excerpt}</p>}
                      {c.article_id && <Link className="btn mt-2" href={`/articles/${c.article_id}`}>記事詳細を開く</Link>}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {raw && <details className="card p-5"><summary className="cursor-pointer font-bold">JSON出力</summary><pre className="mt-3 whitespace-pre-wrap text-xs leading-6">{raw}</pre></details>}
    </div>
  );
}

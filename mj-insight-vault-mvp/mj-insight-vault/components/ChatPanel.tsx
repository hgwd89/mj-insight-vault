'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAppPassword } from '@/components/PasswordGate';

const presets = [
  '今月分を分析して',
  '食品業界だけ分析して',
  '化粧品業界だけ分析して',
  'AI関連の記事を分析して',
  'N1探索に向いている記事を出して',
  '投影法が使えそうなテーマを出して',
  'BOT調査に向いている記事を出して',
  'リフレクションに向いている記事を出して',
  '定量調査に回すべきテーマを出して',
  'リサーチ課題を整理して',
  '提案書ネタにして',
  '元記事に戻れる形で出して',
  'この記事に似た記事を探して'
];

const modelOptions = [
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini'
] as const;

const targetScopes = [
  { value: 'all', label: '全記事', description: '不要記事を除く全記事から検索。' },
  { value: 'recent_30d', label: '直近30日', description: '直近30日の記事だけから検索。' },
  { value: 'latest_batch', label: '最新アップロード', description: '最新アップロード分だけから検索。' }
] as const;

const outputTemplates = [
  { value: 'auto', label: '自動', description: '質問内容に合わせて出力形式を調整。' },
  { value: 'trend', label: '生活者トレンド', description: '生活者変化・背景・示唆を中心に整理。' },
  { value: 'why', label: 'WHY深掘り', description: 'WHYを重ねて背後欲求まで掘る。' },
  { value: 'research', label: 'リサーチ課題化', description: '調査目的・仮説・聞くべき論点へ落とす。' },
  { value: 'proposal', label: '提案書ネタ', description: '企画提案に使える切り口で出す。' },
  { value: 'method', label: '手法適性', description: 'N1・投影・BOT・リフレクション・定量の適性を見る。' },
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

type ChatAnswer = {
  answer_text?: string;
  summary?: string;
  table?: Record<string, unknown>[];
  cards?: ArticleCard[];
  target_scope?: string;
  output_template?: string;
  model_used?: string;
  related_article_count?: number;
  [key: string]: unknown;
};

type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

function getAnswerText(answer: ChatAnswer): string {
  if (typeof answer.answer_text === 'string') return answer.answer_text;
  if (typeof answer.summary === 'string') return answer.summary;
  return '';
}

function evidenceExcerpt(text?: string | null) {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  return compact.length > 220 ? `${compact.slice(0, 220)}...` : compact;
}

export function ChatPanel() {
  const password = useAppPassword();
  const [query, setQuery] = useState('');
  const [model, setModel] = useState<ModelName>('gpt-4.1');
  const [targetScope, setTargetScope] = useState<TargetScope>('all');
  const [outputTemplate, setOutputTemplate] = useState<OutputTemplate>('auto');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [raw, setRaw] = useState('');
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [relatedArticles, setRelatedArticles] = useState<RelatedArticle[]>([]);

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
        headers: {
          'content-type': 'application/json',
          'x-app-password': password
        },
        body: JSON.stringify({
          query: trimmed,
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

      setAnswer(nextAnswer);
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
    setRaw('');
    setQuery('');
    setRelatedArticles([]);
  }

  const relatedById = new Map(relatedArticles.map((article) => [article.id, article]));
  const evidenceCards: ArticleCard[] = answer?.cards?.length
    ? answer.cards
    : relatedArticles.slice(0, 12).map((article) => ({
        article_id: article.id,
        headline: article.headline || '記事',
        article_date: article.article_date || '日付不明',
        evidence_excerpt: evidenceExcerpt(article.ocr_text),
        confidence: article.article_date ? 'medium' : 'low',
        reason: '検索で取得した根拠候補'
      }));

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-xl font-black">チャット分析</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              記事DBを根拠に分析し、続けて追加質問できます。回答はchat_reportsに保存されます。
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
              {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <p className="mt-1 text-xs leading-5 text-zinc-500">OpenAI APIへ渡すモデル名です。</p>
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

        <div className="mt-4 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p} className="btn" onClick={() => { setQuery(p); send(p); }} disabled={busy}>{p}</button>
          ))}
        </div>

        {conversation.length > 0 && (
          <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
            継続中の会話：{conversation.filter((turn) => turn.role === 'user').length}問
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={conversation.length ? 'この分析結果について追加質問' : '分析指示を入力'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send();
            }}
          />
          <button className="btn btn-primary" onClick={() => send()} disabled={busy}>{busy ? '分析中' : '送信'}</button>
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
              {typeof answer.related_article_count === 'number' && <span className="badge">記事 {answer.related_article_count}</span>}
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700">{getAnswerText(answer)}</p>
          </section>

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
                      {excerpt && (
                        <p className="mt-2 rounded-xl bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">
                          {excerpt}
                        </p>
                      )}
                      {c.article_id && <Link className="btn mt-2" href={`/articles/${c.article_id}`}>記事詳細を開く</Link>}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {raw && (
        <details className="card p-5">
          <summary className="cursor-pointer font-bold">JSON出力</summary>
          <pre className="mt-3 whitespace-pre-wrap text-xs leading-6">{raw}</pre>
        </details>
      )}
    </div>
  );
}

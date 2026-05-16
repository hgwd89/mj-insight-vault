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

const analysisModes = [
  { value: 'standard', label: '標準', description: '通常の分析。' },
  { value: 'deep', label: '高精度', description: '精度優先の分析。' },
  { value: 'fast', label: '軽量', description: '速度優先の分析。' },
  { value: 'retrieval_only', label: '記事候補のみ', description: '分析生成をせず、根拠記事だけ確認。' }
] as const;

type AnalysisMode = typeof analysisModes[number]['value'];

type ArticleCard = {
  article_id?: string;
  headline?: string;
  reason?: string;
  note?: string;
};

type ChatAnswer = {
  answer_text?: string;
  summary?: string;
  table?: Record<string, unknown>[];
  cards?: ArticleCard[];
  analysis_mode?: string;
  model_used?: string;
  related_article_count?: number;
  [key: string]: unknown;
};

function getAnswerText(answer: ChatAnswer): string {
  if (typeof answer.answer_text === 'string') return answer.answer_text;
  if (typeof answer.summary === 'string') return answer.summary;
  return '';
}

export function ChatPanel() {
  const password = useAppPassword();
  const [query, setQuery] = useState('');
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('standard');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [raw, setRaw] = useState('');

  const selectedMode = analysisModes.find((mode) => mode.value === analysisMode) || analysisModes[0];

  async function send(q = query) {
    if (!q.trim()) return;

    setBusy(true);
    setAnswer(null);
    setRaw('');

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-app-password': password
        },
        body: JSON.stringify({ query: q, analysis_mode: analysisMode })
      });

      const json = await res.json();

      if (!res.ok) throw new Error(json.error || 'Chat failed');

      setAnswer(json.answer as ChatAnswer);
      setRaw(JSON.stringify(json, null, 2));
    } catch (error) {
      setRaw(error instanceof Error ? error.message : 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h1 className="text-xl font-black">チャット分析</h1>

        <p className="mt-2 text-sm leading-6 text-zinc-600">
          DBから関連する記事だけを抽出し、本文＋表＋記事カードで返します。
          回答はchat_reportsに保存されます。
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-[220px_1fr] md:items-start">
          <label className="block">
            <span className="text-sm font-bold text-zinc-700">分析タイプ</span>
            <select
              className="input mt-2"
              value={analysisMode}
              onChange={(e) => setAnalysisMode(e.target.value as AnalysisMode)}
              disabled={busy}
            >
              {analysisModes.map((mode) => (
                <option key={mode.value} value={mode.value}>{mode.label}</option>
              ))}
            </select>
          </label>

          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 text-zinc-600">
            <b className="text-zinc-800">{selectedMode.label}</b><br />
            {selectedMode.description}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p}
              className="btn"
              onClick={() => {
                setQuery(p);
                send(p);
              }}
              disabled={busy}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="分析指示を入力"
          />

          <button className="btn btn-primary" onClick={() => send()} disabled={busy}>
            {busy ? '分析中' : '送信'}
          </button>
        </div>
      </div>

      {answer && (
        <div className="card space-y-5 p-5">
          <section>
            <h2 className="font-bold">回答</h2>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {answer.analysis_mode && <span className="badge">mode: {answer.analysis_mode}</span>}
              {answer.model_used && <span className="badge">model: {answer.model_used}</span>}
              {typeof answer.related_article_count === 'number' && <span className="badge">記事 {answer.related_article_count}</span>}
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700">{getAnswerText(answer)}</p>
          </section>

          {Array.isArray(answer.table) && answer.table.length > 0 && (
            <section className="overflow-x-auto">
              <h2 className="mb-2 font-bold">整理表</h2>
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr>
                    {Object.keys(answer.table[0]).map((k) => <th key={k} className="border-b bg-zinc-50 p-2 text-left">{k}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {answer.table.map((row, i) => (
                    <tr key={i}>
                      {Object.entries(row).map(([k, v]) => <td key={k} className="border-b p-2 align-top">{String(v ?? '')}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {Array.isArray(answer.cards) && answer.cards.length > 0 && (
            <section>
              <h2 className="mb-2 font-bold">根拠記事カード</h2>
              <div className="grid gap-3">
                {answer.cards.map((c, i) => (
                  <div key={i} className="rounded-xl border border-zinc-200 p-3">
                    <p className="font-semibold">{c.headline || c.article_id || '記事'}</p>
                    <p className="mt-1 text-sm leading-6 text-zinc-600">{c.reason || c.note || ''}</p>
                    {c.article_id && <Link className="btn mt-2" href={`/articles/${c.article_id}`}>記事詳細を開く</Link>}
                  </div>
                ))}
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

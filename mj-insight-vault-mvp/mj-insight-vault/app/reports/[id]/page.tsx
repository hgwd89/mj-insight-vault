'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type Report = {
  id: string;
  user_query: string;
  answer_text: string | null;
  answer_json: Record<string, unknown> | null;
  related_article_ids: string[] | null;
  created_at: string;
};

type Article = {
  id: string;
  headline: string | null;
  article_date: string | null;
  ocr_text: string | null;
  status: string | null;
  created_at: string;
};

type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

type ReportChatAnswer = {
  answer_text?: string;
  suggested_next_angles?: string[];
  referenced_articles?: { article_id?: string; headline?: string; reason?: string }[];
  model_used?: string;
  [key: string]: unknown;
};

const modelOptions = ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'] as const;

type ModelName = typeof modelOptions[number];

function getAnswerText(answer: ReportChatAnswer) {
  return typeof answer.answer_text === 'string' ? answer.answer_text : JSON.stringify(answer, null, 2);
}

function getInitialAnswer(report: Report) {
  if (report.answer_text) return report.answer_text;
  const answer = report.answer_json || {};
  if (typeof answer.answer_text === 'string') return answer.answer_text;
  if (typeof answer.summary === 'string') return answer.summary;
  return JSON.stringify(answer, null, 2);
}

function getReportTitle(report: Report) {
  const title = report.answer_json?.report_title;
  return typeof title === 'string' && title.trim() ? title : report.user_query;
}

function getPinned(report: Report) {
  return Boolean(report.answer_json?.pinned);
}

function buildMarkdown(report: Report, articles: Article[], latestAnswer: ReportChatAnswer | null) {
  const title = getReportTitle(report);
  const initialAnswer = getInitialAnswer(report);
  const lines = [
    `# ${title}`,
    '',
    `- 作成日: ${new Date(report.created_at).toLocaleString('ja-JP')}`,
    `- 元指示: ${report.user_query}`,
    '',
    '## 元レポート',
    '',
    initialAnswer,
    ''
  ];

  if (latestAnswer) {
    lines.push('## 追加回答', '', getAnswerText(latestAnswer), '');
  }

  lines.push('## 根拠記事', '');

  if (!articles.length) {
    lines.push('- 根拠記事なし');
  } else {
    for (const article of articles) {
      lines.push(`- ${article.article_date || '日付不明'}｜${article.headline || '無題の記事'}｜${article.id}`);
    }
  }

  return lines.join('\n');
}

export default function ReportDetailPage() {
  const params = useParams<{ id: string }>();
  const password = useAppPassword();
  const { data, error, loading } = useApi<{ report: Report; related_articles: Article[] }>(`/api/reports/${params.id}`);

  const [query, setQuery] = useState('');
  const [model, setModel] = useState<ModelName>('gpt-4.1');
  const [busy, setBusy] = useState(false);
  const [metaBusy, setMetaBusy] = useState(false);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [latestAnswer, setLatestAnswer] = useState<ReportChatAnswer | null>(null);
  const [raw, setRaw] = useState('');
  const [title, setTitle] = useState('');
  const [pinned, setPinned] = useState(false);

  const report = data?.report;
  const articles = useMemo(() => data?.related_articles || [], [data?.related_articles]);

  useEffect(() => {
    if (!report) return;
    setTitle(getReportTitle(report));
    setPinned(getPinned(report));
  }, [report]);

  async function saveMetadata(nextPinned = pinned) {
    if (!report) return;

    setMetaBusy(true);

    try {
      const res = await fetch(`/api/reports/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ report_title: title, pinned: nextPinned })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'レポート設定の保存に失敗しました');

      setPinned(Boolean(json.report?.answer_json?.pinned));
      alert('保存しました');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'レポート設定の保存に失敗しました');
    } finally {
      setMetaBusy(false);
    }
  }

  async function togglePinned() {
    const next = !pinned;
    setPinned(next);
    await saveMetadata(next);
  }

  async function copyMarkdown() {
    if (!report) return;

    try {
      await navigator.clipboard.writeText(buildMarkdown(report, articles, latestAnswer));
      alert('Markdownをコピーしました');
    } catch {
      alert('コピーに失敗しました。ブラウザの権限を確認してください。');
    }
  }

  async function send(q = query) {
    const trimmed = q.trim();
    if (!trimmed) return;

    setBusy(true);
    setRaw('');

    const userTurn: ConversationTurn = { role: 'user', content: trimmed };
    const nextConversation: ConversationTurn[] = [...conversation, userTurn];

    try {
      const res = await fetch(`/api/reports/${params.id}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-app-password': password
        },
        body: JSON.stringify({
          query: trimmed,
          model,
          conversation
        })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'レポートチャットに失敗しました');

      const answer = json.answer as ReportChatAnswer;
      const answerText = getAnswerText(answer);
      const assistantTurn: ConversationTurn = { role: 'assistant', content: answerText };

      setLatestAnswer(answer);
      setRaw(JSON.stringify(json, null, 2));
      setConversation([...nextConversation, assistantTurn].slice(-12));
      setQuery('');
    } catch (error) {
      setRaw(error instanceof Error ? error.message : 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  }

  function resetChat() {
    setConversation([]);
    setLatestAnswer(null);
    setRaw('');
    setQuery('');
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;
  if (!report) return <div className="card p-5 text-red-600">レポートがありません</div>;

  const suggestedQuestions = [
    'この分析の本質仮説をもっと尖らせて',
    'リサーチ課題に落とすとどうなる？',
    'N1探索で聞くべき質問を出して',
    '提案書の見出し案にして',
    '見落としている生活者変化を追加して',
    '根拠記事ごとに使い道を整理して'
  ];

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex-1">
            <p className="text-xs text-zinc-500">{new Date(report.created_at).toLocaleString('ja-JP')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {pinned && <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700">Pinned</span>}
              <h1 className="text-xl font-black">レポート対話</h1>
            </div>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              既存レポートと根拠記事を前提に、GPTのように分析観点を追加しながら掘り下げます。
            </p>
          </div>
          <Link className="btn" href="/reports">分析履歴へ戻る</Link>
        </div>
      </div>

      <section className="card p-5">
        <h2 className="font-bold">レポート設定</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="レポート名" disabled={metaBusy} />
          <button className="btn" onClick={() => saveMetadata()} disabled={metaBusy}>名前保存</button>
          <button className={pinned ? 'btn btn-primary' : 'btn'} onClick={togglePinned} disabled={metaBusy}>{pinned ? 'ピン解除' : 'ピン留め'}</button>
          <button className="btn" onClick={copyMarkdown}>Markdownコピー</button>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-bold">元の指示</h2>
        <p className="mt-2 rounded-xl bg-zinc-50 p-3 text-sm leading-7">{report.user_query}</p>

        <h2 className="mt-5 font-bold">元レポート</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm leading-7 text-zinc-700">{getInitialAnswer(report)}</p>
      </section>

      <section className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-bold">MJ記事エージェントに追加質問</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">
              結果への質問、分析観点の追加、仮説の再整理、リサーチ設計への変換ができます。
            </p>
          </div>
          <button className="btn" onClick={resetChat} disabled={busy}>会話リセット</button>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[240px_1fr]">
          <label className="block">
            <span className="text-sm font-bold text-zinc-700">APIモデル</span>
            <select className="input mt-2" value={model} onChange={(e) => setModel(e.target.value as ModelName)} disabled={busy}>
              {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>

          <div>
            <span className="text-sm font-bold text-zinc-700">よく使う追加指示</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestedQuestions.map((q) => (
                <button key={q} className="btn" onClick={() => send(q)} disabled={busy}>{q}</button>
              ))}
            </div>
          </div>
        </div>

        {conversation.length > 0 && (
          <div className="mt-4 space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
            {conversation.map((turn, index) => (
              <div key={index} className="text-sm leading-6">
                <b>{turn.role === 'user' ? 'あなた' : 'MJ記事エージェント'}：</b>
                <span className="whitespace-pre-wrap">{turn.content}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="このレポートについて追加で聞く"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send();
            }}
          />
          <button className="btn btn-primary" onClick={() => send()} disabled={busy || !query.trim()}>
            {busy ? '分析中' : '送信'}
          </button>
        </div>
      </section>

      {latestAnswer && (
        <section className="card p-5">
          <h2 className="font-bold">追加回答</h2>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {latestAnswer.model_used && <span className="badge">model: {latestAnswer.model_used}</span>}
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700">{getAnswerText(latestAnswer)}</p>

          {Array.isArray(latestAnswer.suggested_next_angles) && latestAnswer.suggested_next_angles.length > 0 && (
            <div className="mt-4">
              <h3 className="font-bold">次に掘る観点</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-700">
                {latestAnswer.suggested_next_angles.map((angle, index) => <li key={index}>{angle}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="card p-5">
        <h2 className="font-bold">根拠記事</h2>
        <div className="mt-3 grid gap-3">
          {articles.length === 0 && <p className="text-sm text-zinc-500">根拠記事は保存されていません。</p>}
          {articles.map((article) => (
            <div key={article.id} className="rounded-xl border border-zinc-200 p-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{article.headline || '無題の記事'}</p>
                    <span className="badge">{article.article_date || '日付不明'}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-600">{article.ocr_text}</p>
                </div>
                <Link className="btn shrink-0" href={`/articles/${article.id}`}>記事詳細</Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {raw && (
        <details className="card p-5">
          <summary className="cursor-pointer font-bold">JSON出力</summary>
          <pre className="mt-3 whitespace-pre-wrap text-xs leading-6">{raw}</pre>
        </details>
      )}
    </div>
  );
}

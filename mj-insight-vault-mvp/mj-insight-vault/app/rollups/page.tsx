'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';
import { RollupsOperationGuide } from '@/components/RollupsOperationGuide';

type MonthlyRollup = {
  id: string;
  month_key: string;
  article_count: number;
  status: string;
  summary_text: string;
  summary_json: Record<string, unknown> | null;
  representative_article_ids: string[] | null;
  evidence_article_ids: string[] | null;
  rollup_model: string;
  error_message: string | null;
  generated_at: string | null;
  updated_at: string;
};

type ApiData = {
  months: string[];
  month_counts?: Record<string, number>;
  needed_months?: string[];
  pending_months?: string[];
  invalid_ready_months?: string[];
  rollups: MonthlyRollup[];
  stale_months: string[];
};

function shortText(value: string | null | undefined, max = 500) {
  const content = value || '';
  return content.length > max ? `${content.slice(0, max)}...` : content;
}

function statusClass(status: string) {
  if (status === 'ready') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'stale' || status === 'provisional') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (status === 'running' || status === 'queued') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-zinc-200 bg-zinc-50 text-zinc-600';
}

function statusLabel(status: string) {
  if (status === 'ready') return '使用可';
  if (status === 'stale') return '要更新';
  if (status === 'queued') return '待機中';
  if (status === 'running') return '生成中';
  if (status === 'failed') return '失敗';
  if (status === 'provisional') return '暫定（Chat非使用）';
  return '未作成';
}

function extractList(json: Record<string, unknown> | null, key: string, max = 5) {
  const value = json?.[key];
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return String(record.theme || record.title || record.claim || record.hypothesis || record.summary || record.note || JSON.stringify(record));
    }
    return String(item || '');
  }).filter(Boolean);
}

function number(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rollupProgress(rollup: MonthlyRollup | undefined) {
  const json = rollup?.summary_json || {};
  const total = number(json.total_chunks);
  const completed = number(json.completed_chunks);
  if (!total) return null;
  return { completed, total };
}

export default function MonthlyRollupsPage() {
  const password = useAppPassword();
  const { data, error, loading } = useApi<ApiData>('/api/rollups/monthly');
  const [months, setMonths] = useState<string[]>([]);
  const [monthCounts, setMonthCounts] = useState<Record<string, number>>({});
  const [neededMonths, setNeededMonths] = useState<string[]>([]);
  const [pendingMonths, setPendingMonths] = useState<string[]>([]);
  const [invalidReadyMonths, setInvalidReadyMonths] = useState<string[]>([]);
  const [rollups, setRollups] = useState<MonthlyRollup[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const applyData = useCallback((value: ApiData | null | undefined) => {
    setMonths(value?.months || []);
    setMonthCounts(value?.month_counts || {});
    setNeededMonths(value?.needed_months || []);
    setPendingMonths(value?.pending_months || []);
    setInvalidReadyMonths(value?.invalid_ready_months || []);
    setRollups(value?.rollups || []);
  }, []);

  useEffect(() => applyData(data), [applyData, data]);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/rollups/monthly', { headers: { 'x-app-password': password } });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '月別まとめの再取得に失敗しました');
    applyData(json as ApiData);
    return json as ApiData;
  }, [applyData, password]);

  useEffect(() => {
    if (!pendingMonths.length) return;
    const timer = window.setInterval(() => {
      void refresh().catch((refreshError) => {
        setMessage(refreshError instanceof Error ? refreshError.message : '進捗の再取得に失敗しました');
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [pendingMonths.length, refresh]);

  const rollupByMonth = useMemo(() => new Map(rollups.map((rollup) => [rollup.month_key, rollup])), [rollups]);
  const staleCount = rollups.filter((rollup) => rollup.status === 'stale').length;
  const readyCount = rollups.filter((rollup) => rollup.status === 'ready' && !invalidReadyMonths.includes(rollup.month_key)).length;
  const provisionalCount = rollups.filter((rollup) => rollup.status === 'provisional').length;
  const failedCount = rollups.filter((rollup) => rollup.status === 'failed').length;
  const missingCount = months.filter((month) => !rollupByMonth.has(month)).length;
  const totalArticles = Object.values(monthCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  const neededCount = neededMonths.length;
  const pendingCount = pendingMonths.length;
  const nextAction = neededCount > 0
    ? `生成・更新が必要な月が${neededCount}件あります。「必要な月だけ生成」を押してください。`
    : pendingCount > 0
      ? `生成処理中の月が${pendingCount}件あります。画面は10秒ごとに自動更新します。`
      : months.length > 0
        ? '検証済みの全月ロールアップが揃っています。Chatで全体分析に進めます。'
        : '記事日付が入った記事がまだありません。先に記事をアップロードしてください。';

  async function generate(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setMessage(`${label}をキューへ投入しています。`);
    try {
      const res = await fetch('/api/rollups/monthly', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${label}に失敗しました`);
      applyData(json as ApiData);
      const queuedCount = number(json.queued_count);
      const attempted = Array.isArray(json.attempted_months) ? json.attempted_months.map(String) : [];
      const kickWarning = String(json.worker_kick_error || '');
      if (!queuedCount) {
        setMessage(`${label}: 新たに投入する対象はありませんでした。`);
      } else {
        setMessage(`${label}: ${queuedCount}件をキュー投入しました（${attempted.join(', ')}）。完了ではありません。ワーカーが順次処理します。${kickWarning ? ` 即時起動には失敗しましたが、定期ワーカーが継続します: ${kickWarning}` : ''}`);
      }
    } catch (generateError) {
      setMessage(generateError instanceof Error ? generateError.message : `${label}に失敗しました`);
    } finally {
      setBusy('');
    }
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  return (
    <div className="space-y-4">
      <RollupsOperationGuide
        monthCount={months.length}
        readyCount={readyCount}
        staleCount={staleCount}
        failedCount={failedCount}
        missingCount={missingCount}
        totalArticles={totalArticles}
      />

      <section className="card border-zinc-900 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-bold text-zinc-500">次にやること</p>
            <h1 className="mt-1 text-xl font-black">{nextAction}</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              生成は再開可能な分割ワーカーで進みます。ボタンの応答は「完了」ではなく「キュー投入」です。readyかつ検証済みになるまでChat全体分析には使いません。
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button className="btn btn-primary" type="button" disabled={Boolean(busy) || neededCount === 0} onClick={() => generate({ needs_only: true }, '必要な月だけ生成')}>必要な月だけ生成</button>
            <button className="btn" type="button" disabled={Boolean(busy) || staleCount === 0} onClick={() => generate({ stale_only: true }, 'stale月だけ再生成')}>stale月だけ再生成</button>
            <button className="btn" type="button" disabled={Boolean(busy) || months.length === 0} onClick={() => generate({ all: true }, '全月を強制再生成')}>全月を強制再生成</button>
          </div>
        </div>
      </section>

      <div className="card p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-xl font-black">月別まとめ</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">記事本文を月単位で分割分析し、階層統合します。</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="badge">記事あり月 {months.length}</span>
              <span className="badge">検証済み {readyCount}</span>
              <span className="badge">処理中 {pendingCount}</span>
              <span className="badge">必要 {neededCount}</span>
              <span className="badge">無効な旧ready {invalidReadyMonths.length}</span>
              <span className="badge">暫定 {provisionalCount}</span>
              <span className="badge">失敗 {failedCount}</span>
              <span className="badge">対象記事 {totalArticles}</span>
            </div>
          </div>
          <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => refresh().catch((refreshError) => setMessage(refreshError instanceof Error ? refreshError.message : '再取得に失敗しました'))}>再取得</button>
        </div>
        {message && <p className="mt-4 rounded-xl bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">{message}</p>}
      </div>

      {months.length === 0 && <div className="card p-5 text-sm text-zinc-500">記事日付が入った記事がありません。</div>}

      {months.map((month) => {
        const rollup = rollupByMonth.get(month);
        const themes = extractList(rollup?.summary_json || null, 'major_themes');
        const weakSignals = extractList(rollup?.summary_json || null, 'weak_signals');
        const researchNeeds = extractList(rollup?.summary_json || null, 'research_needs');
        const invalidReady = invalidReadyMonths.includes(month);
        const status = invalidReady ? 'invalid_ready' : rollup?.status || 'missing';
        const articleCount = monthCounts[month] ?? rollup?.article_count ?? 0;
        const usedInChat = rollup?.status === 'ready' && !invalidReady;
        const progress = rollupProgress(rollup);
        return (
          <section key={month} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-black">{month}</h2>
                  <span className={`rounded-full border px-2 py-1 text-xs font-bold ${statusClass(status)}`}>{invalidReady ? '旧形式・再生成必要' : statusLabel(status)}</span>
                  <span className="badge">対象 {articleCount}記事</span>
                  <span className="badge">{usedInChat ? 'Chat全体分析に使用' : 'Chat全体分析では未使用'}</span>
                  {rollup?.rollup_model && <span className="badge">model: {rollup.rollup_model}</span>}
                  {progress && <span className="badge">本文チャンク {progress.completed}/{progress.total}</span>}
                  {rollup?.generated_at && <span className="badge">生成: {new Date(rollup.generated_at).toLocaleString('ja-JP')}</span>}
                </div>
                {rollup?.error_message && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm leading-6 text-red-700">{rollup.error_message}</p>}
                {rollup?.summary_text ? <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-zinc-700">{shortText(rollup.summary_text)}</p> : <p className="mt-3 text-sm text-zinc-500">まだ月別まとめは生成されていません。</p>}
                {(themes.length > 0 || weakSignals.length > 0 || researchNeeds.length > 0) && (
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    {themes.length > 0 && <div className="rounded-xl bg-zinc-50 p-3"><p className="text-xs font-bold text-zinc-500">主要テーマ</p><ul className="mt-2 list-disc pl-5 text-sm leading-6 text-zinc-700">{themes.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                    {weakSignals.length > 0 && <div className="rounded-xl bg-zinc-50 p-3"><p className="text-xs font-bold text-zinc-500">弱い兆し</p><ul className="mt-2 list-disc pl-5 text-sm leading-6 text-zinc-700">{weakSignals.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                    {researchNeeds.length > 0 && <div className="rounded-xl bg-zinc-50 p-3"><p className="text-xs font-bold text-zinc-500">調査論点</p><ul className="mt-2 list-disc pl-5 text-sm leading-6 text-zinc-700">{researchNeeds.map((item) => <li key={item}>{item}</li>)}</ul></div>}
                  </div>
                )}
              </div>
              <button className="btn shrink-0" type="button" disabled={Boolean(busy) || status === 'queued' || status === 'running'} onClick={() => generate({ month_key: month, force: true }, `${month}を再生成`)}>
                {rollup ? 'この月を再生成' : 'この月を生成'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

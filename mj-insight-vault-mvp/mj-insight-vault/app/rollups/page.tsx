'use client';

import { useEffect, useMemo, useState } from 'react';
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
  rollups: MonthlyRollup[];
  stale_months: string[];
};

function shortText(value: string | null | undefined, max = 500) {
  const text = value || '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function statusClass(status: string) {
  if (status === 'ready') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (status === 'stale') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (status === 'running') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-zinc-200 bg-zinc-50 text-zinc-600';
}

function statusLabel(status: string) {
  if (status === 'ready') return '使用可';
  if (status === 'stale') return '要更新';
  if (status === 'running') return '生成中';
  if (status === 'failed') return '失敗';
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

export default function MonthlyRollupsPage() {
  const password = useAppPassword();
  const { data, error, loading } = useApi<ApiData>('/api/rollups/monthly');
  const [months, setMonths] = useState<string[]>([]);
  const [monthCounts, setMonthCounts] = useState<Record<string, number>>({});
  const [neededMonths, setNeededMonths] = useState<string[]>([]);
  const [rollups, setRollups] = useState<MonthlyRollup[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setMonths(data?.months || []);
    setMonthCounts(data?.month_counts || {});
    setNeededMonths(data?.needed_months || []);
    setRollups(data?.rollups || []);
  }, [data]);

  const rollupByMonth = useMemo(() => new Map(rollups.map((rollup) => [rollup.month_key, rollup])), [rollups]);
  const staleCount = rollups.filter((rollup) => rollup.status === 'stale').length;
  const readyCount = rollups.filter((rollup) => rollup.status === 'ready').length;
  const failedCount = rollups.filter((rollup) => rollup.status === 'failed').length;
  const runningCount = rollups.filter((rollup) => rollup.status === 'running').length;
  const missingCount = months.filter((month) => !rollupByMonth.has(month)).length;
  const totalArticles = Object.values(monthCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  const neededCount = neededMonths.length || missingCount + staleCount + failedCount;
  const nextAction = neededCount > 0
    ? `生成・更新が必要な月が${neededCount}件あります。「必要な月だけ生成」を押してください。`
    : runningCount > 0
      ? `生成中の月が${runningCount}件あります。少し待ってから再取得してください。`
      : months.length > 0
        ? '全月が使用可能です。Chatで全体分析に進めます。'
        : '記事日付が入った記事がまだありません。先に記事をアップロードしてください。';

  async function refresh() {
    const res = await fetch('/api/rollups/monthly', { headers: { 'x-app-password': password } });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '月別まとめの再取得に失敗しました');
    setMonths(json.months || []);
    setMonthCounts(json.month_counts || {});
    setNeededMonths(json.needed_months || []);
    setRollups(json.rollups || []);
  }

  async function generate(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setMessage(`${label}を開始しました。対象記事数が多い月は時間がかかります。`);
    try {
      const res = await fetch('/api/rollups/monthly', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify(body)
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `${label}に失敗しました`);
      await refresh();
      const count = Array.isArray(json.rollups) ? json.rollups.length : json.rollup ? 1 : 0;
      setMessage(`${label}が完了しました。更新: ${count}件`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : `${label}に失敗しました`);
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
              通常は「必要な月だけ生成」を使ってください。「全月を強制再生成」は時間とAPIコストがかかるため、月別まとめの設計を変えた時だけ使います。
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
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              月別まとめを生成・更新します。新しい記事が追加された月は要更新になります。
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="badge">記事あり月 {months.length}</span>
              <span className="badge">使用可 {readyCount}</span>
              <span className="badge">未作成 {missingCount}</span>
              <span className="badge">要更新 {staleCount}</span>
              <span className="badge">失敗 {failedCount}</span>
              <span className="badge">必要 {neededCount}</span>
              <span className="badge">rollup対象記事 {totalArticles}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => refresh().catch((e) => setMessage(e instanceof Error ? e.message : '再取得に失敗しました'))}>再取得</button>
            <button className="btn btn-primary" type="button" disabled={Boolean(busy) || neededCount === 0} onClick={() => generate({ needs_only: true }, '必要な月だけ生成')}>必要な月だけ生成</button>
          </div>
        </div>
        {message && <p className="mt-4 rounded-xl bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">{message}</p>}
      </div>

      {months.length === 0 && <div className="card p-5 text-sm text-zinc-500">記事日付が入った記事がありません。</div>}

      {months.map((month) => {
        const rollup = rollupByMonth.get(month);
        const themes = extractList(rollup?.summary_json || null, 'major_themes');
        const weakSignals = extractList(rollup?.summary_json || null, 'weak_signals');
        const researchNeeds = extractList(rollup?.summary_json || null, 'research_needs');
        const status = rollup?.status || '未作成';
        const articleCount = monthCounts[month] ?? rollup?.article_count ?? 0;
        const usedInChat = rollup?.status === 'ready';
        return (
          <section key={month} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-black">{month}</h2>
                  <span className={`rounded-full border px-2 py-1 text-xs font-bold ${statusClass(status)}`}>{statusLabel(status)}</span>
                  <span className="badge">この記事数から作成 {articleCount}</span>
                  <span className="badge">{usedInChat ? 'Chat全体分析に使われます' : 'Chat全体分析では未使用'}</span>
                  {rollup?.rollup_model && <span className="badge">model: {rollup.rollup_model}</span>}
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
              <button className="btn shrink-0" type="button" disabled={Boolean(busy)} onClick={() => generate({ month_key: month }, `${month}を生成`)}>
                {rollup ? 'この月を再生成' : 'この月を生成'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

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
  const [rollups, setRollups] = useState<MonthlyRollup[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setMonths(data?.months || []);
    setRollups(data?.rollups || []);
  }, [data]);

  const rollupByMonth = useMemo(() => new Map(rollups.map((rollup) => [rollup.month_key, rollup])), [rollups]);
  const staleCount = rollups.filter((rollup) => rollup.status === 'stale').length;
  const readyCount = rollups.filter((rollup) => rollup.status === 'ready').length;
  const totalArticles = rollups.reduce((sum, rollup) => sum + Number(rollup.article_count || 0), 0);

  async function refresh() {
    const res = await fetch('/api/rollups/monthly', { headers: { 'x-app-password': password } });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || '月別まとめの再取得に失敗しました');
    setMonths(json.months || []);
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
      <div className="card p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-xl font-black">月別まとめ</h1>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              記事ストックは削らず、月ごとの要約・弱い兆し・反証・調査論点を保存します。全体分析ではこの月別まとめを優先して読みます。
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="badge">記事あり月 {months.length}</span>
              <span className="badge">生成済み {readyCount}</span>
              <span className="badge">要再生成 {staleCount}</span>
              <span className="badge">rollup対象記事 {totalArticles}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => refresh().catch((e) => setMessage(e instanceof Error ? e.message : '再取得に失敗しました'))}>再取得</button>
            <button className="btn" type="button" disabled={Boolean(busy) || staleCount === 0} onClick={() => generate({ stale_only: true }, 'stale月だけ再生成')}>stale月だけ再生成</button>
            <button className="btn btn-primary" type="button" disabled={Boolean(busy) || months.length === 0} onClick={() => generate({ all: true }, '全月まとめ生成')}>全月まとめ生成</button>
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
        return (
          <section key={month} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-black">{month}</h2>
                  <span className={`rounded-full border px-2 py-1 text-xs font-bold ${statusClass(status)}`}>{status}</span>
                  {rollup && <span className="badge">記事 {rollup.article_count}</span>}
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
                {rollup ? '再生成' : '生成'}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

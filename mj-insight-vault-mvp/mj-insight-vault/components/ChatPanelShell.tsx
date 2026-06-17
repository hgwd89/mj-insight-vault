'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ChatPanel } from '@/components/ChatPanel';
import { useAppPassword } from '@/components/PasswordGate';

type LatestReport = {
  id: string;
  created_at?: string;
  user_query?: string;
  answer_head?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function formatTokyoDateTime(value: unknown) {
  const raw = text(value);
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

async function fetchLatestReport(password: string): Promise<LatestReport | null> {
  try {
    const response = await fetch('/api/diagnostics/latest-report', { headers: { 'x-app-password': password } });
    const json = await response.json();
    if (!response.ok || !isRecord(json.report)) return null;
    const id = text(json.report.id);
    if (!id) return null;
    return {
      id,
      created_at: text(json.report.created_at),
      user_query: text(json.report.user_query),
      answer_head: text(json.report.answer_head)
    };
  } catch {
    return null;
  }
}

export function ChatPanelShell() {
  const password = useAppPassword();
  const [latestReport, setLatestReport] = useState<LatestReport | null>(null);

  const refresh = useCallback(async () => {
    setLatestReport(await fetchLatestReport(password));
  }, [password]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  return (
    <div className="space-y-4">
      {latestReport && (
        <div className="card border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-bold">最新レポートがあります。</p>
              {latestReport.created_at && <p className="text-xs text-emerald-800">作成: {formatTokyoDateTime(latestReport.created_at)}</p>}
              {latestReport.answer_head && <p className="mt-1 line-clamp-2">{latestReport.answer_head}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Link className="btn bg-white" href={`/reports/${latestReport.id}`}>最新レポートを開く</Link>
              <Link className="btn bg-white" href="/reports">分析履歴</Link>
              <button className="btn bg-white" type="button" onClick={refresh}>更新</button>
            </div>
          </div>
        </div>
      )}
      <ChatPanel />
    </div>
  );
}

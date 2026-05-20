'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const KEY = 'mj-chat-active-run-v2';
const EVENT = 'mj-chat-run-state';

type RunState = {
  status?: string;
  report_id?: string;
  report_title?: string;
  answer_preview?: string;
  progress?: number;
  stage?: string;
};

function readRun(): RunState | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as RunState : null;
  } catch {
    return null;
  }
}

export function ChatLastReportLink() {
  const [run, setRun] = useState<RunState | null>(null);

  useEffect(() => {
    setRun(readRun());
    const onRun = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as RunState | null : readRun();
      setRun(detail || null);
    };
    window.addEventListener(EVENT, onRun);
    return () => window.removeEventListener(EVENT, onRun);
  }, []);

  if (!run || (!run.report_id && run.status !== 'complete' && run.status !== 'running' && run.status !== 'queued')) return null;

  return (
    <section className="card p-4 text-sm leading-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="font-bold">直近のチャット分析</p>
          <p className="text-zinc-600">{run.stage || (run.status === 'complete' ? 'レポート生成完了' : '処理中')}</p>
          {run.answer_preview && <p className="mt-2 line-clamp-3 text-zinc-700">{run.answer_preview}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {run.report_id && <Link className="btn btn-primary" href={`/reports/${run.report_id}`}>レポートを開く</Link>}
          <Link className="btn" href="/reports">分析履歴</Link>
        </div>
      </div>
    </section>
  );
}

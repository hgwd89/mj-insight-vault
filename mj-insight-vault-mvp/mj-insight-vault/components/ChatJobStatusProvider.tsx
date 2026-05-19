'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const CHAT_RUN_STORAGE_KEY = 'mj-chat-active-run-v2';
const CHAT_RUN_EVENT = 'mj-chat-run-state';

type ChatRunStatus = 'queued' | 'running' | 'complete' | 'error';
type ChatRunState = {
  status: ChatRunStatus;
  query: string;
  model?: string;
  target_scope?: string;
  output_template?: string;
  started_at: number;
  updated_at: number;
  progress?: number;
  stage?: string;
  job_id?: string;
  report_id?: string;
  report_title?: string;
  answer_preview?: string;
  error?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function num(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeJsonParse(value: unknown): JsonRecord {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readChatRunState(): ChatRunState | null {
  if (typeof window === 'undefined') return null;
  const parsed = safeJsonParse(window.sessionStorage.getItem(CHAT_RUN_STORAGE_KEY));
  if (parsed.status === 'queued' || parsed.status === 'running' || parsed.status === 'complete' || parsed.status === 'error') return parsed as ChatRunState;
  return null;
}

function writeChatRunState(next: ChatRunState | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!next) window.sessionStorage.removeItem(CHAT_RUN_STORAGE_KEY);
    else window.sessionStorage.setItem(CHAT_RUN_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(CHAT_RUN_EVENT, { detail: next }));
  } catch {
    // Do not let status UI break the app.
  }
}

function reportTitleFromResult(result: JsonRecord) {
  const answer = isRecord(result.answer) ? result.answer : {};
  return text(answer.report_title);
}

function answerPreviewFromResult(result: JsonRecord) {
  const answer = isRecord(result.answer) ? result.answer : {};
  const value = text(answer.answer_text || answer.summary || answer.report_title);
  return value.length > 180 ? `${value.slice(0, 180)}...` : value;
}

function reportIdFromResult(result: JsonRecord) {
  if (isRecord(result.report)) return text(result.report.id);
  return '';
}

function stateFromJob(job: JsonRecord, fallback: ChatRunState): ChatRunState {
  const statusRaw = text(job.status);
  const status: ChatRunStatus = statusRaw === 'completed' ? 'complete' : statusRaw === 'failed' ? 'error' : statusRaw === 'queued' ? 'queued' : 'running';
  const result = isRecord(job.result_json) ? job.result_json : {};
  return {
    ...fallback,
    status,
    job_id: text(job.id) || fallback.job_id,
    progress: num(job.progress, fallback.progress || 0),
    stage: text(job.stage) || fallback.stage,
    updated_at: job.updated_at ? new Date(text(job.updated_at)).getTime() : Date.now(),
    report_id: text(job.report_id) || reportIdFromResult(result) || fallback.report_id,
    report_title: reportTitleFromResult(result) || fallback.report_title,
    answer_preview: answerPreviewFromResult(result) || fallback.answer_preview,
    error: text(job.error_message) || fallback.error
  };
}

function progress(run: ChatRunState) {
  if (run.status === 'complete') return 100;
  if (run.status === 'error') return 100;
  return Math.max(0, Math.min(99, Math.round(run.progress || 0)));
}

function elapsedText(run: ChatRunState) {
  if (run.status === 'complete') return '完了';
  if (run.status === 'error') return '停止';
  const elapsedSec = Math.max(0, Math.floor((Date.now() - run.started_at) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}秒経過`;
  return `${Math.floor(elapsedSec / 60)}分${elapsedSec % 60}秒経過`;
}

export function ChatJobStatusProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const password = useAppPassword();
  const [run, setRun] = useState<ChatRunState | null>(null);

  async function refresh(current = run) {
    if (!current?.job_id) return;
    try {
      const response = await fetch(`/api/chat/jobs/${current.job_id}`, {
        headers: { 'x-app-password': password }
      });
      const json = await response.json();
      if (!response.ok || !isRecord(json.job)) return;
      const next = stateFromJob(json.job, current);
      writeChatRunState(next);
      setRun(next);
    } catch {
      // best-effort
    }
  }

  useEffect(() => {
    const stored = readChatRunState();
    setRun(stored);

    const onRunState = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as ChatRunState | null : readChatRunState();
      setRun(detail || null);
    };
    const onFocus = () => {
      const current = readChatRunState();
      if (current?.job_id) void refresh(current);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      onFocus();
    };

    window.addEventListener(CHAT_RUN_EVENT, onRunState);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener(CHAT_RUN_EVENT, onRunState);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [password]);

  useEffect(() => {
    if (!run?.job_id || (run.status !== 'queued' && run.status !== 'running')) return;
    const timer = window.setInterval(() => void refresh(readChatRunState() || run), 3000);
    return () => window.clearInterval(timer);
  }, [run?.job_id, run?.status, password]);

  function close() {
    writeChatRunState(null);
    setRun(null);
  }

  const show = run && pathname !== '/chat';
  const p = run ? progress(run) : 0;
  const isActive = run?.status === 'queued' || run?.status === 'running';
  const isComplete = run?.status === 'complete';

  return (
    <>
      {children}
      {show && (
        <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-3xl rounded-2xl border border-zinc-200 bg-white/95 p-3 text-sm shadow-2xl backdrop-blur">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate font-bold">
                  {isActive ? 'チャット分析中' : isComplete ? 'チャット分析完了' : 'チャット分析エラー'}
                </p>
                <span className="shrink-0 text-xs font-bold text-zinc-500">{p}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
                <div className={`h-full rounded-full transition-all duration-500 ${run.status === 'error' ? 'bg-red-600' : isComplete ? 'bg-emerald-600' : 'bg-zinc-900'}`} style={{ width: `${p}%` }} />
              </div>
              <p className="mt-1 truncate text-xs text-zinc-600">{run.stage || run.query || '処理中'} / {elapsedText(run)}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              {isComplete && <Link className="btn btn-primary" href={run.report_id ? `/reports/${run.report_id}` : '/reports'}>開く</Link>}
              {isActive && <Link className="btn" href="/chat">状況を見る</Link>}
              {run.status === 'error' && <Link className="btn" href="/chat">確認</Link>}
              <button className="btn" type="button" onClick={close}>閉じる</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

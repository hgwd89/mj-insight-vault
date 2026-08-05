'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const CHAT_RUN_STORAGE_KEY = 'mj-chat-active-run-v3';
const LEGACY_SESSION_KEY = 'mj-chat-active-run-v2';
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
  next_retry_at?: string;
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

function validRunState(value: JsonRecord): value is JsonRecord & ChatRunState {
  return value.status === 'queued' || value.status === 'running' || value.status === 'complete' || value.status === 'error';
}

function readChatRunState(): ChatRunState | null {
  if (typeof window === 'undefined') return null;
  const current = safeJsonParse(window.localStorage.getItem(CHAT_RUN_STORAGE_KEY));
  if (validRunState(current)) return current;

  const legacy = safeJsonParse(window.sessionStorage.getItem(LEGACY_SESSION_KEY));
  if (validRunState(legacy)) {
    try {
      window.localStorage.setItem(CHAT_RUN_STORAGE_KEY, JSON.stringify(legacy));
      window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
    } catch {
      // Continue with the in-memory legacy state.
    }
    return legacy;
  }
  return null;
}

function writeChatRunState(next: ChatRunState | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!next) window.localStorage.removeItem(CHAT_RUN_STORAGE_KEY);
    else window.localStorage.setItem(CHAT_RUN_STORAGE_KEY, JSON.stringify(next));
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

function baseStateFromJob(job: JsonRecord): ChatRunState {
  const request = isRecord(job.request_json) ? job.request_json : {};
  const createdAt = text(job.created_at);
  const createdMs = createdAt ? Date.parse(createdAt) : Date.now();
  return {
    status: 'queued',
    query: text(job.user_query || request.query) || 'レポート生成',
    model: text(request.model),
    target_scope: text(request.target_scope),
    output_template: text(request.output_template),
    started_at: Number.isNaN(createdMs) ? Date.now() : createdMs,
    updated_at: Date.now(),
    progress: num(job.progress, 3),
    stage: text(job.stage) || 'ジョブを復元しました',
    job_id: text(job.id)
  };
}

function stateFromJob(job: JsonRecord, fallback?: ChatRunState): ChatRunState {
  const base = fallback || baseStateFromJob(job);
  const statusRaw = text(job.status);
  const status: ChatRunStatus = statusRaw === 'completed' ? 'complete' : statusRaw === 'failed' ? 'error' : statusRaw === 'queued' ? 'queued' : 'running';
  const result = isRecord(job.result_json) ? job.result_json : {};
  const updatedAt = text(job.updated_at);
  const updatedMs = updatedAt ? Date.parse(updatedAt) : Date.now();
  return {
    ...base,
    status,
    job_id: text(job.id) || base.job_id,
    progress: num(job.progress, base.progress || 0),
    stage: text(job.stage) || base.stage,
    updated_at: Number.isNaN(updatedMs) ? Date.now() : updatedMs,
    report_id: text(job.report_id) || reportIdFromResult(result) || base.report_id,
    report_title: reportTitleFromResult(result) || base.report_title,
    answer_preview: answerPreviewFromResult(result) || base.answer_preview,
    error: text(job.error_message) || base.error,
    next_retry_at: text(job.next_retry_at) || undefined
  };
}

function progress(run: ChatRunState) {
  if (run.status === 'complete' || run.status === 'error') return 100;
  return Math.max(0, Math.min(99, Math.round(run.progress || 0)));
}

function elapsedText(run: ChatRunState) {
  if (run.status === 'complete') return '完了';
  if (run.status === 'error') return '停止';
  const elapsedSec = Math.max(0, Math.floor((Date.now() - run.started_at) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}秒経過`;
  return `${Math.floor(elapsedSec / 60)}分${elapsedSec % 60}秒経過`;
}

function retryIsDue(run: ChatRunState) {
  if (!run.next_retry_at) return true;
  const parsed = Date.parse(run.next_retry_at);
  return Number.isNaN(parsed) || parsed <= Date.now();
}

export function ChatJobStatusProvider({ children }: { children: React.ReactNode }) {
  const password = useAppPassword();
  const [run, setRun] = useState<ChatRunState | null>(null);
  const resumingJobIdsRef = useRef<Set<string>>(new Set());

  const resumeQueuedJob = useCallback(async (current: ChatRunState) => {
    if (!current.job_id || current.status !== 'queued' || !retryIsDue(current)) return;
    if (resumingJobIdsRef.current.has(current.job_id)) return;

    resumingJobIdsRef.current.add(current.job_id);
    try {
      const response = await fetch(`/api/chat/jobs/${current.job_id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password }
      });
      const json = await response.json().catch(() => ({}));
      if (isRecord(json) && isRecord(json.job)) {
        const next = stateFromJob(json.job, current);
        writeChatRunState(next);
        setRun(next);
        return;
      }
      if (!response.ok) {
        const errorRun: ChatRunState = {
          ...current,
          status: 'error',
          progress: 100,
          stage: '分析に失敗しました',
          error: isRecord(json) ? text(json.error) || response.statusText : response.statusText,
          updated_at: Date.now()
        };
        writeChatRunState(errorRun);
        setRun(errorRun);
      }
    } catch {
      // Network failures are retried by the normal status refresh cycle.
    } finally {
      resumingJobIdsRef.current.delete(current.job_id);
    }
  }, [password]);

  const refresh = useCallback(async (current: ChatRunState | null) => {
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
      if (next.status === 'queued') void resumeQueuedJob(next);
    } catch {
      // Best-effort polling.
    }
  }, [password, resumeQueuedJob]);

  const discoverActiveJob = useCallback(async () => {
    try {
      const response = await fetch('/api/chat/jobs?active=1', {
        headers: { 'x-app-password': password }
      });
      const json = await response.json();
      if (!response.ok || !isRecord(json.job)) return null;
      const next = stateFromJob(json.job);
      writeChatRunState(next);
      setRun(next);
      if (next.status === 'queued') void resumeQueuedJob(next);
      return next;
    } catch {
      return null;
    }
  }, [password, resumeQueuedJob]);

  useEffect(() => {
    const stored = readChatRunState();
    setRun(stored);
    if (stored?.job_id) void refresh(stored);
    else void discoverActiveJob();

    const onRunState = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as ChatRunState | null : readChatRunState();
      setRun(detail || null);
      if (detail?.status === 'queued') void resumeQueuedJob(detail);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CHAT_RUN_STORAGE_KEY) return;
      const current = readChatRunState();
      setRun(current);
      if (current?.status === 'queued') void resumeQueuedJob(current);
    };
    const onFocus = () => {
      const current = readChatRunState();
      if (current?.job_id) void refresh(current);
      else void discoverActiveJob();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onFocus();
    };

    window.addEventListener(CHAT_RUN_EVENT, onRunState);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener(CHAT_RUN_EVENT, onRunState);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [discoverActiveJob, refresh, resumeQueuedJob]);

  useEffect(() => {
    if (!run?.job_id || (run.status !== 'queued' && run.status !== 'running')) return;
    const timer = window.setInterval(() => void refresh(readChatRunState() || run), 5000);
    return () => window.clearInterval(timer);
  }, [refresh, run]);

  function close() {
    writeChatRunState(null);
    setRun(null);
  }

  const show = Boolean(run);
  const p = run ? progress(run) : 0;
  const isActive = run?.status === 'queued' || run?.status === 'running';
  const isComplete = run?.status === 'complete';

  return (
    <>
      {children}
      {show && run && (
        <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-3xl rounded-2xl border border-zinc-200 bg-white/95 p-3 text-sm shadow-2xl backdrop-blur">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate font-bold">
                  {isActive ? 'レポート処理中' : isComplete ? 'レポート生成完了' : 'レポート生成エラー'}
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
              {isActive && <Link className="btn" href="/reports">状況を見る</Link>}
              {run.status === 'error' && <Link className="btn" href="/chat">確認</Link>}
              <button className="btn" type="button" onClick={close}>閉じる</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

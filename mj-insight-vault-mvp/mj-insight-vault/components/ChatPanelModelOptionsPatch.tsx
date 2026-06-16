'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatPanel } from '@/components/ChatPanel';
import { useAppPassword } from '@/components/PasswordGate';

const ALL_DATA_RE = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て|全期間/;
const DEEP_RE = /本気|しっかり|詳細|深掘|深堀|高品質|レポート|インサイト|ナラティブ|構造|横断|説明仮説|仮説|調査|リサーチ|論点|WHY|why/;
const LIGHT_RE = /軽く|ざっくり|簡単|概要|一覧|傾向だけ|軽量|速報|まずは|ラフ/;
const CHAT_RUN_STORAGE_KEY = 'mj-chat-active-run-v3';
const LEGACY_CHAT_RUN_STORAGE_KEY = 'mj-chat-active-run-v2';
const CHAT_RUN_EVENT = 'mj-chat-run-state';
const STALLED_CREATE_MS = 8000;

type JsonRecord = Record<string, unknown>;
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

type LatestReport = {
  id: string;
  created_at?: string;
  user_query?: string;
  answer_head?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
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

function toMarkdown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  if (!isRecord(value)) return '';
  return Object.entries(value).map(([key, sectionValue]) => {
    if (sectionValue === undefined || sectionValue === null) return '';
    const body = typeof sectionValue === 'string'
      ? sectionValue.trim()
      : Array.isArray(sectionValue)
        ? sectionValue.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n')
        : isRecord(sectionValue)
          ? JSON.stringify(sectionValue, null, 2)
          : text(sectionValue);
    return body ? `## ${key}\n${body}` : '';
  }).filter(Boolean).join('\n\n').trim();
}

function normalizeChatJson(json: unknown) {
  if (!isRecord(json)) return json;
  if (!isRecord(json.answer)) return json;
  const answer = { ...json.answer } as JsonRecord;
  answer.answer_text = toMarkdown(answer.answer_text) || text(answer.summary) || text(answer.report_title) || JSON.stringify(answer, null, 2);
  if (!Array.isArray(answer.cards) && Array.isArray(json.related_articles)) {
    answer.cards = json.related_articles.map((article) => {
      if (!isRecord(article)) return null;
      const id = text(article.id);
      return {
        article_id: id,
        headline: text(article.headline || '記事'),
        article_date: text(article.article_date || '日付不明'),
        article_url: id ? `/articles/${id}` : '',
        article_link: id ? `[${text(article.headline || '記事')}｜${text(article.article_date || '日付不明')}](/articles/${id})` : '',
        reason: '検索で取得した根拠候補',
        confidence: article.article_date ? 'medium' : 'low'
      };
    }).filter(Boolean);
  }
  return { ...json, answer };
}

function stripReportInstruction(query: string) {
  return query.split('\n\n【レポート要件】')[0].trim() || query.trim();
}

function answerPreview(answer: unknown) {
  if (!isRecord(answer)) return '';
  const value = text(answer.answer_text || answer.summary || answer.report_title);
  return value.length > 220 ? `${value.slice(0, 220)}...` : value;
}

function reportTitleFromAnswer(answer: unknown) {
  return isRecord(answer) ? text(answer.report_title) : '';
}

function reportIdFromJson(json: unknown) {
  if (!isRecord(json)) return '';
  if (isRecord(json.report)) return text(json.report.id);
  if (isRecord(json.job)) return text(json.job.report_id);
  return '';
}

function isDirectChatEndpoint(target: string) {
  try {
    const url = target.startsWith('http') ? new URL(target) : new URL(target, window.location.origin);
    return url.pathname === '/api/chat';
  } catch {
    return target === '/api/chat';
  }
}

function buildJobHeaders(password: string, base?: HeadersInit): Headers {
  const headers = new Headers(base || {});
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('x-app-password', password);
  return headers;
}

function requestHeaders(init: RequestInit | undefined, password: string) {
  return buildJobHeaders(password, init?.headers);
}

function writeChatRunState(next: ChatRunState | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!next) {
      window.sessionStorage.removeItem(CHAT_RUN_STORAGE_KEY);
      window.sessionStorage.removeItem(LEGACY_CHAT_RUN_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(CHAT_RUN_STORAGE_KEY, JSON.stringify(next));
      window.sessionStorage.removeItem(LEGACY_CHAT_RUN_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent(CHAT_RUN_EVENT, { detail: next }));
  } catch {
    // Persistence must not break chat.
  }
}

function readChatRunState(): ChatRunState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(CHAT_RUN_STORAGE_KEY) || window.sessionStorage.getItem(LEGACY_CHAT_RUN_STORAGE_KEY);
    const parsed = safeJsonParse(raw);
    if (parsed.status === 'queued' || parsed.status === 'running' || parsed.status === 'complete' || parsed.status === 'error') return parsed as ChatRunState;
    return null;
  } catch {
    return null;
  }
}

function stateFromJob(job: JsonRecord, fallback: ChatRunState): ChatRunState {
  const statusRaw = text(job.status);
  const status: ChatRunStatus = statusRaw === 'completed' ? 'complete' : statusRaw === 'failed' ? 'error' : statusRaw === 'queued' ? 'queued' : 'running';
  const result = isRecord(job.result_json) ? job.result_json : {};
  const answer = isRecord(result.answer) ? result.answer : {};
  const reportId = text(job.report_id) || reportIdFromJson(result);
  return {
    ...fallback,
    status,
    job_id: text(job.id) || fallback.job_id,
    progress: status === 'complete' ? 100 : num(job.progress, fallback.progress || 0),
    stage: text(job.stage) || fallback.stage || (status === 'complete' ? 'レポート生成完了' : ''),
    updated_at: job.updated_at ? new Date(text(job.updated_at)).getTime() : Date.now(),
    report_id: reportId || fallback.report_id,
    report_title: reportTitleFromAnswer(answer) || fallback.report_title,
    answer_preview: answerPreview(answer) || fallback.answer_preview,
    error: text(job.error_message) || fallback.error
  };
}

async function fetchJob(originalFetch: typeof window.fetch, jobId: string, headers: HeadersInit, fallback: ChatRunState) {
  const response = await originalFetch(`/api/chat/jobs/${jobId}`, { headers });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'ジョブ状態の取得に失敗しました');
  if (!isRecord(json.job)) return fallback;
  return stateFromJob(json.job, fallback);
}

async function fetchReportResult(originalFetch: typeof window.fetch, reportId: string, headers: HeadersInit) {
  const response = await originalFetch(`/api/reports/${reportId}`, { headers });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'レポート取得に失敗しました');
  if (!isRecord(json.report)) return json;
  return normalizeChatJson({
    report: json.report,
    answer: isRecord(json.report.answer_json) ? json.report.answer_json : {},
    related_articles: Array.isArray(json.related_articles) ? json.related_articles : []
  });
}

async function fetchLatestReport(originalFetch: typeof window.fetch, headers: HeadersInit): Promise<LatestReport | null> {
  try {
    const response = await originalFetch('/api/diagnostics/latest-report', { headers });
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

function completedStateFromReport(report: LatestReport, fallback: ChatRunState | null): ChatRunState {
  const updated = report.created_at ? new Date(report.created_at).getTime() : Date.now();
  return {
    status: 'complete',
    query: fallback?.query || report.user_query || '最新レポート',
    model: fallback?.model,
    target_scope: fallback?.target_scope,
    output_template: fallback?.output_template,
    started_at: fallback?.started_at || updated,
    updated_at: updated || Date.now(),
    progress: 100,
    stage: 'レポート生成完了',
    job_id: fallback?.job_id,
    report_id: report.id,
    report_title: '最新レポート',
    answer_preview: report.answer_head || fallback?.answer_preview
  };
}

async function pollJobUntilDone(originalFetch: typeof window.fetch, jobId: string, headers: HeadersInit, fallback: ChatRunState) {
  let current = fallback;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    current = await fetchJob(originalFetch, jobId, headers, current);
    writeChatRunState(current);
    if (current.status === 'complete' || current.status === 'error') return current;
  }
}

async function runExistingJob(originalFetch: typeof window.fetch, jobId: string, headers: HeadersInit, fallback: ChatRunState) {
  const runningState: ChatRunState = {
    ...fallback,
    status: 'running',
    progress: Math.max(6, fallback.progress || 6),
    stage: fallback.stage || '分析を再開中',
    updated_at: Date.now()
  };
  writeChatRunState(runningState);

  const runResponse = await originalFetch(`/api/chat/jobs/${jobId}/run`, { method: 'POST', headers });
  let runJson: unknown = {};
  try { runJson = await runResponse.json(); } catch { runJson = {}; }

  if (!runResponse.ok) {
    const latest = await fetchJob(originalFetch, jobId, headers, runningState).catch(() => runningState);
    if (latest.status === 'complete') {
      writeChatRunState(latest);
      return latest;
    }
    const errorState: ChatRunState = {
      ...runningState,
      status: 'error',
      progress: 100,
      stage: '分析に失敗しました',
      error: isRecord(runJson) ? text(runJson.error) || runResponse.statusText : runResponse.statusText,
      updated_at: Date.now()
    };
    writeChatRunState(errorState);
    return errorState;
  }

  const finalState = isRecord(runJson) && isRecord(runJson.job) ? stateFromJob(runJson.job, runningState) : runningState;
  const result = isRecord(runJson) && isRecord(runJson.result) ? normalizeChatJson(runJson.result) : runJson;
  const resultRecord = isRecord(result) ? result : {};
  const answer = resultRecord.answer;

  if (finalState.status === 'complete') {
    const completed: ChatRunState = {
      ...finalState,
      progress: 100,
      stage: 'レポート生成完了',
      updated_at: Date.now(),
      report_id: reportIdFromJson(resultRecord) || finalState.report_id,
      report_title: reportTitleFromAnswer(answer) || finalState.report_title,
      answer_preview: answerPreview(answer) || finalState.answer_preview
    };
    writeChatRunState(completed);
    return completed;
  }

  writeChatRunState(finalState);
  return finalState;
}

function selectedModel() {
  const labels = Array.from(document.querySelectorAll('label'));
  const modelLabel = labels.find((label) => label.textContent?.includes('APIモデル'));
  const select = modelLabel?.querySelector('select') as HTMLSelectElement | null;
  return select?.value || '';
}

function selectedScope() {
  const labels = Array.from(document.querySelectorAll('label'));
  const scopeLabel = labels.find((label) => label.textContent?.includes('分析対象'));
  const select = scopeLabel?.querySelector('select') as HTMLSelectElement | null;
  return select?.value || '';
}

function currentQuery() {
  const input = Array.from(document.querySelectorAll('input')).find((el) => {
    const placeholder = el.getAttribute('placeholder') || '';
    return placeholder.includes('分析指示') || placeholder.includes('追加質問');
  }) as HTMLInputElement | undefined;
  return input?.value || '';
}

function isSendButton(target: EventTarget | null) {
  const el = target instanceof HTMLElement ? target.closest('button') : null;
  const buttonText = el?.textContent?.trim() || '';
  return el && (buttonText === '送信' || buttonText === '分析中');
}

function isEnterSend(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  const el = event.target instanceof HTMLInputElement ? event.target : null;
  if (!el) return false;
  const placeholder = el.getAttribute('placeholder') || '';
  return placeholder.includes('分析指示') || placeholder.includes('追加質問');
}

function shouldWarn() {
  const model = selectedModel();
  const scope = selectedScope();
  const query = currentQuery();
  const allData = scope === 'all' && ALL_DATA_RE.test(query);
  const deep = DEEP_RE.test(query) && !LIGHT_RE.test(query);
  return model === 'gpt-5' && (allData || deep);
}

function warningMessage() {
  return [
    '高コストになりやすい分析です。',
    '',
    '条件:',
    '- モデル: gpt-5',
    `- 分析対象: ${selectedScope() || '不明'}`,
    ALL_DATA_RE.test(currentQuery()) ? '- 指示: 全データ / 全記事 / 全体分析系' : '- 指示: 深掘り / レポート / インサイト分析系',
    '',
    '続行すると、月別rollupと代表記事を使って最終レポートを作成します。',
    'コストを抑えるなら gpt-5-mini または gpt-5-nano を選んでください。',
    '',
    'このまま続行しますか？'
  ].join('\n');
}

function confirmHighCost(event: Event) {
  if (!shouldWarn()) return;
  const ok = window.confirm(warningMessage());
  if (ok) return;
  event.preventDefault();
  event.stopPropagation();
  if ('stopImmediatePropagation' in event) event.stopImmediatePropagation();
}

function formatTime(value: number) {
  if (!value) return '';
  return new Date(value).toLocaleString('ja-JP');
}

function progressLabel(run: ChatRunState) {
  const p = Math.max(0, Math.min(100, Math.round(run.progress || 0)));
  if (run.status === 'complete') return '100%';
  if (run.status === 'error') return '停止';
  return `${p}%`;
}

function estimateText(run: ChatRunState) {
  if (run.status === 'complete') return '完了';
  if (run.status === 'error') return 'エラー終了';
  if (!run.job_id && run.progress && run.progress <= 1) return 'ジョブ作成応答待ちです。保存済みレポートがあれば下のボタンから開けます';
  const stage = run.stage || '';
  if (/最終|OpenAI|レポート|分析/.test(stage)) return '最終生成中です。数分かかることがあります';
  if (/スキャン|選抜|検索|取得/.test(stage)) return '記事を読み込み・選抜中です';
  if (/保存|完了/.test(stage)) return '保存処理中です';
  return '工程ベースで進捗を更新しています';
}

function ProgressBar({ run }: { run: ChatRunState }) {
  const progress = Math.max(0, Math.min(100, Math.round(run.progress || (run.status === 'running' ? 8 : 0))));
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs font-bold">
        <span>{run.stage || (run.status === 'queued' ? '待機中' : '分析中')}</span>
        <span>{progressLabel(run)}</span>
      </div>
      <div className="mt-2 h-3 overflow-hidden rounded-full bg-white/70 ring-1 ring-black/10">
        <div className="h-full rounded-full bg-zinc-900 transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>
      <p className="mt-1 text-xs">{estimateText(run)}</p>
    </div>
  );
}

function RunStatusCard({ run, latestReport, onClear, onRefresh }: { run: ChatRunState; latestReport: LatestReport | null; onClear: () => void; onRefresh: () => void }) {
  const reportId = run.report_id || latestReport?.id || '';
  const hasOutput = Boolean(reportId);

  if (run.status === 'queued' || run.status === 'running') {
    return (
      <div className="card border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex-1">
            <p className="font-bold">分析中です。保存済みレポートがあれば、この状態でも出力を開けます。</p>
            <p className="mt-1">開始: {formatTime(run.started_at)} / モデル: {run.model || '不明'} / 対象: {run.target_scope || '不明'}</p>
            {run.query && <p className="mt-1 line-clamp-2">指示: {run.query}</p>}
            <ProgressBar run={run} />
            {hasOutput && <p className="mt-2 font-bold text-emerald-800">保存済みレポートがあります。下の「レポートを開く」から出力を確認できます。</p>}
            <p className="mt-2 text-xs">更新でjob状態を再取得します。1%のままでも、最新レポートが保存済みなら出力導線を優先表示します。</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {hasOutput && <Link className="btn bg-white" href={`/reports/${reportId}`}>レポートを開く</Link>}
            <button className="btn bg-white" type="button" onClick={onRefresh}>更新</button>
            <Link className="btn bg-white" href="/reports">分析履歴</Link>
            <button className="btn bg-white" type="button" onClick={onClear}>閉じる</button>
          </div>
        </div>
      </div>
    );
  }

  if (run.status === 'complete') {
    return (
      <div className="card border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex-1">
            <p className="font-bold">分析が完了しました。</p>
            <p className="mt-1">完了: {formatTime(run.updated_at)}{run.report_title ? ` / ${run.report_title}` : ''}</p>
            <ProgressBar run={run} />
            {run.answer_preview && <p className="mt-2 line-clamp-2">{run.answer_preview}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link className="btn bg-white" href={reportId ? `/reports/${reportId}` : '/reports'}>レポートを開く</Link>
            <Link className="btn bg-white" href="/reports">分析履歴</Link>
            <button className="btn bg-white" type="button" onClick={onClear}>閉じる</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex-1">
          <p className="font-bold">分析はエラーで終了しました。</p>
          <ProgressBar run={run} />
          <p className="mt-2">{run.error || '不明なエラー'}</p>
          {hasOutput && <p className="mt-2 font-bold text-emerald-800">ただし保存済みレポートがあります。</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {hasOutput && <Link className="btn bg-white" href={`/reports/${reportId}`}>レポートを開く</Link>}
          <button className="btn bg-white" type="button" onClick={onClear}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

function patchFetch(password: string) {
  const original = window.fetch;
  if ((original as typeof window.fetch & { __chatPatched?: boolean }).__chatPatched) return () => undefined;

  const patched: typeof window.fetch & { __chatPatched?: boolean } = async (...args) => {
    const target = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
    if (!isDirectChatEndpoint(target)) return original(...args);

    const init = args[1] as RequestInit | undefined;
    const requestBody = safeJsonParse(init?.body);
    const headers = requestHeaders(init, password);
    const startedAt = Date.now();
    let runState: ChatRunState = {
      status: 'queued',
      query: stripReportInstruction(text(requestBody.query) || currentQuery()),
      model: text(requestBody.model || selectedModel()),
      target_scope: text(requestBody.target_scope || selectedScope()),
      output_template: text(requestBody.output_template),
      started_at: startedAt,
      updated_at: startedAt,
      progress: 1,
      stage: 'ジョブを作成中'
    };

    writeChatRunState(runState);

    try {
      const createResponse = await original('/api/chat/jobs', { method: 'POST', headers, body: JSON.stringify(requestBody) });
      const createJson = await createResponse.json();
      if (!createResponse.ok || !isRecord(createJson.job)) throw new Error(createJson.error || 'ジョブ作成に失敗しました');
      runState = stateFromJob(createJson.job, runState);
      writeChatRunState(runState);

      const jobId = runState.job_id || text(createJson.job.id);
      if (!jobId) throw new Error('ジョブIDを取得できませんでした');

      runState = { ...runState, status: 'running', progress: Math.max(5, runState.progress || 5), stage: '分析実行を開始', updated_at: Date.now() };
      writeChatRunState(runState);

      const runPromise = original(`/api/chat/jobs/${jobId}/run`, { method: 'POST', headers });
      const pollPromise = pollJobUntilDone(original, jobId, headers, runState).catch(() => runState);
      const runResponse = await runPromise;
      let runJson: unknown = {};
      try { runJson = await runResponse.json(); } catch { runJson = {}; }
      const latestState = await pollPromise;

      if (!runResponse.ok) {
        if (latestState.status === 'complete' && latestState.report_id) {
          const reportResult = await fetchReportResult(original, latestState.report_id, headers);
          writeChatRunState(latestState);
          return new Response(JSON.stringify(reportResult), { status: 200, headers: runResponse.headers });
        }
        const errorState: ChatRunState = { ...latestState, status: 'error', progress: 100, stage: '分析に失敗しました', error: isRecord(runJson) ? text(runJson.error) || runResponse.statusText : runResponse.statusText || '分析に失敗しました', updated_at: Date.now() };
        writeChatRunState(errorState);
        return new Response(JSON.stringify({ error: errorState.error }), { status: runResponse.status, statusText: runResponse.statusText, headers: runResponse.headers });
      }

      const result = isRecord(runJson) && isRecord(runJson.result)
        ? normalizeChatJson(runJson.result)
        : isRecord(runJson) && isRecord(runJson.job) && isRecord(runJson.job.result_json)
          ? normalizeChatJson(runJson.job.result_json)
          : latestState.report_id
            ? await fetchReportResult(original, latestState.report_id, headers).catch(() => runJson)
            : runJson;
      const resultRecord = isRecord(result) ? result : {};
      const answer = resultRecord.answer;
      const completed: ChatRunState = {
        ...latestState,
        status: 'complete',
        progress: 100,
        stage: 'レポート生成完了',
        updated_at: Date.now(),
        report_id: reportIdFromJson(resultRecord) || latestState.report_id,
        report_title: reportTitleFromAnswer(answer) || latestState.report_title,
        answer_preview: answerPreview(answer) || latestState.answer_preview
      };
      writeChatRunState(completed);

      return new Response(JSON.stringify(result), { status: 200, statusText: runResponse.statusText, headers: runResponse.headers });
    } catch (error) {
      const latest = await fetchLatestReport(original, headers);
      if (latest && Date.now() - startedAt > STALLED_CREATE_MS) {
        const completed = completedStateFromReport(latest, runState);
        writeChatRunState(completed);
        const reportResult = await fetchReportResult(original, latest.id, headers).catch(() => ({ report: { id: latest.id }, answer: { answer_text: latest.answer_head || '' }, related_articles: [] }));
        return new Response(JSON.stringify(reportResult), { status: 200, statusText: 'Recovered latest report' });
      }
      const errorState: ChatRunState = { ...runState, status: 'error', progress: 100, stage: '分析に失敗しました', updated_at: Date.now(), error: error instanceof Error ? error.message : '分析に失敗しました' };
      writeChatRunState(errorState);
      return new Response(JSON.stringify({ error: errorState.error }), { status: 500, statusText: 'Chat job failed' });
    }
  };

  patched.__chatPatched = true;
  window.fetch = patched;
  return () => { window.fetch = original; };
}

export function ChatPanelModelOptionsPatch() {
  const password = useAppPassword();
  const jobHeaders = useMemo(() => buildJobHeaders(password), [password]);
  const [runState, setRunState] = useState<ChatRunState | null>(null);
  const [latestReport, setLatestReport] = useState<LatestReport | null>(null);
  const originalFetchRef = useRef<typeof window.fetch | null>(null);
  const resumingJobIdsRef = useRef<Set<string>>(new Set());

  const refreshLatestReport = useCallback(async () => {
    const fetcher = originalFetchRef.current || window.fetch;
    const latest = await fetchLatestReport(fetcher, jobHeaders);
    setLatestReport(latest);
    return latest;
  }, [jobHeaders]);

  const resumeQueuedJob = useCallback(async (current: ChatRunState) => {
    if (!current.job_id || current.status !== 'queued') return;
    if (resumingJobIdsRef.current.has(current.job_id)) return;
    const fetcher = originalFetchRef.current || window.fetch;
    resumingJobIdsRef.current.add(current.job_id);
    try {
      const next = await runExistingJob(fetcher, current.job_id, jobHeaders, current);
      writeChatRunState(next);
      setRunState(next);
      await refreshLatestReport();
    } catch {
      // Best effort.
    } finally {
      resumingJobIdsRef.current.delete(current.job_id);
    }
  }, [jobHeaders, refreshLatestReport]);

  const refreshRunState = useCallback(async (current = runState) => {
    const fetcher = originalFetchRef.current || window.fetch;
    try {
      if (current?.job_id) {
        const next = await fetchJob(fetcher, current.job_id, jobHeaders, current);
        writeChatRunState(next);
        setRunState(next);
        const latest = await refreshLatestReport();
        if ((next.status === 'queued' || next.status === 'running') && latest?.id) {
          setLatestReport(latest);
        }
        if (next.status === 'queued') void resumeQueuedJob(next);
        return;
      }

      const latest = await refreshLatestReport();
      if (current && (current.status === 'queued' || current.status === 'running') && latest?.id) {
        const recovered = completedStateFromReport(latest, current);
        writeChatRunState(recovered);
        setRunState(recovered);
      }
    } catch {
      // Manual refresh should not break the page.
    }
  }, [jobHeaders, refreshLatestReport, resumeQueuedJob, runState]);

  useEffect(() => {
    const stored = readChatRunState();
    setRunState(stored);
    const original = window.fetch;
    originalFetchRef.current = original;
    const restoreFetch = patchFetch(password);
    void refreshLatestReport();

    const onRunState = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as ChatRunState | null : readChatRunState();
      setRunState(detail || null);
      if (detail?.status === 'queued') void resumeQueuedJob(detail);
      void refreshLatestReport();
    };
    const onClick = (event: MouseEvent) => { if (isSendButton(event.target)) confirmHighCost(event); };
    const onKeyDown = (event: KeyboardEvent) => { if (isEnterSend(event)) confirmHighCost(event); };
    const onFocus = () => {
      const current = readChatRunState();
      void refreshRunState(current || undefined);
      void refreshLatestReport();
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };

    window.addEventListener(CHAT_RUN_EVENT, onRunState);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    if (stored?.status === 'queued') void resumeQueuedJob(stored);
    if (stored && !stored.job_id && (stored.status === 'queued' || stored.status === 'running')) void refreshRunState(stored);
    return () => {
      restoreFetch();
      window.removeEventListener(CHAT_RUN_EVENT, onRunState);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [password, refreshLatestReport, refreshRunState, resumeQueuedJob]);

  useEffect(() => {
    if (!runState || (runState.status !== 'queued' && runState.status !== 'running')) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      await refreshRunState(readChatRunState() || runState);
    }, runState.job_id ? 2500 : 3500);
    void refreshRunState(runState);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshRunState, runState?.job_id, runState?.status, runState?.updated_at]);

  function clearRunState() {
    writeChatRunState(null);
    setRunState(null);
    void refreshLatestReport();
  }

  return (
    <div className="space-y-4">
      {!runState && latestReport && (
        <div className="card border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-bold">最新レポートがあります。</p>
              {latestReport.answer_head && <p className="mt-1 line-clamp-2">{latestReport.answer_head}</p>}
            </div>
            <div className="flex gap-2">
              <Link className="btn bg-white" href={`/reports/${latestReport.id}`}>最新レポートを開く</Link>
              <Link className="btn bg-white" href="/reports">分析履歴</Link>
            </div>
          </div>
        </div>
      )}
      {runState && <RunStatusCard run={runState} latestReport={latestReport} onClear={clearRunState} onRefresh={() => refreshRunState()} />}
      <ChatPanel />
    </div>
  );
}

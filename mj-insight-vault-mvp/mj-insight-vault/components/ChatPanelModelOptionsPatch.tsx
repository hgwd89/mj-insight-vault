'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChatPanel } from '@/components/ChatPanel';

const ALL_DATA_RE = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/;
const DEEP_RE = /本気|しっかり|詳細|深掘|深堀|高品質|レポート|インサイト|ナラティブ|構造|横断|説明仮説|仮説|調査|リサーチ|論点|WHY|why/;
const LIGHT_RE = /軽く|ざっくり|簡単|概要|一覧|傾向だけ|軽量|速報|まずは|ラフ/;
const CHAT_RUN_STORAGE_KEY = 'mj-chat-active-run-v1';
const CHAT_RUN_EVENT = 'mj-chat-run-state';

type JsonRecord = Record<string, unknown>;
type ChatRunState = {
  status: 'running' | 'complete' | 'error';
  query: string;
  model?: string;
  target_scope?: string;
  output_template?: string;
  started_at: number;
  updated_at: number;
  report_id?: string;
  report_title?: string;
  answer_preview?: string;
  error?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function mdList(values: unknown[]) {
  return values.map((item) => {
    if (typeof item === 'string') return `- ${item}`;
    if (isRecord(item)) {
      const title = text(item.theme || item.hypothesis || item.claim || item.title || item.finding || item.phenomenon);
      const detail = text(item.why_research_needed || item.explanation || item.underlying_motive || item.mechanism || item.limitation || item.reason);
      if (title && detail) return `- ${title}：${detail}`;
      if (title) return `- ${title}`;
    }
    return `- ${JSON.stringify(item)}`;
  }).filter(Boolean).join('\n');
}

function toMarkdown(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return mdList(value);
  if (!isRecord(value)) return '';

  return Object.entries(value).map(([key, sectionValue]) => {
    if (sectionValue === undefined || sectionValue === null) return '';
    let body = '';
    if (typeof sectionValue === 'string') body = sectionValue.trim();
    else if (Array.isArray(sectionValue)) body = mdList(sectionValue);
    else if (isRecord(sectionValue)) body = Object.entries(sectionValue).map(([k, v]) => `### ${k}\n${Array.isArray(v) ? mdList(v) : isRecord(v) ? JSON.stringify(v, null, 2) : text(v)}`).join('\n\n');
    else body = text(sectionValue);
    return body ? `## ${key}\n${body}` : '';
  }).filter(Boolean).join('\n\n').trim();
}

function fallbackAnswerText(answer: JsonRecord) {
  const parts: string[] = [];
  const title = text(answer.report_title);
  if (title) parts.push(`# ${title}`);
  const summary = toMarkdown(answer.executive_summary);
  if (summary) parts.push(`## 要旨\n${summary}`);
  const narrative = toMarkdown(answer.consumer_narrative || answer.consumer_trend_narrative);
  if (narrative) parts.push(`## 生活者動向のナラティブ\n${narrative}`);
  const hypotheses = toMarkdown(answer.explanatory_hypotheses || answer.insight_hypotheses || answer.why_chains);
  if (hypotheses) parts.push(`## 説明仮説（WHY3段階）\n${hypotheses}`);
  const needs = toMarkdown(answer.research_needs);
  if (needs) parts.push(`## 調査が必要そうな論点\n${needs}`);
  const limits = toMarkdown(answer.limitations || answer.weak_readings_to_avoid);
  if (limits) parts.push(`## 根拠と限界\n${limits}`);
  return parts.join('\n\n').trim();
}

function normalizeCards(value: unknown, fallback: unknown) {
  if (!Array.isArray(value)) return fallback;
  const cards = value.map((item) => {
    if (!isRecord(item)) return null;
    const article_id = text(item.article_id || item.id);
    const headline = text(item.headline || item.title);
    if (!article_id && !headline) return null;
    return {
      article_id,
      headline,
      article_date: text(item.article_date || item.date || '日付不明'),
      article_url: text(item.article_url),
      article_link: text(item.article_link),
      reason: text(item.reason || item.note || '根拠候補'),
      confidence: text(item.confidence || 'medium')
    };
  }).filter(Boolean);
  return cards.length ? cards : fallback;
}

function normalizeChatJson(json: unknown) {
  if (!isRecord(json) || !isRecord(json.answer)) return json;

  const answer = { ...json.answer } as JsonRecord;
  const baseCards = Array.isArray(answer.cards) ? answer.cards : [];
  const relatedCards = Array.isArray(json.related_articles) ? json.related_articles.map((article) => {
    if (!isRecord(article)) return null;
    const articleId = text(article.id);
    return {
      article_id: articleId,
      headline: text(article.headline || '記事'),
      article_date: text(article.article_date || '日付不明'),
      article_url: articleId ? `/articles/${articleId}` : '',
      article_link: articleId ? `[${text(article.headline || '記事')}｜${text(article.article_date || '日付不明')}](/articles/${articleId})` : '',
      reason: '検索で取得した根拠候補',
      confidence: article.article_date ? 'medium' : 'low'
    };
  }).filter(Boolean) : [];

  const answerText = toMarkdown(answer.answer_text) || fallbackAnswerText(answer) || JSON.stringify(answer, null, 2);
  const executive = Array.isArray(answer.executive_summary)
    ? answer.executive_summary.map(text).filter(Boolean)
    : text(answer.executive_summary) ? [text(answer.executive_summary)] : [];
  const hypotheses = Array.isArray(answer.explanatory_hypotheses)
    ? answer.explanatory_hypotheses
    : Array.isArray(answer.insight_hypotheses)
      ? answer.insight_hypotheses.map((item) => isRecord(item) ? item : { hypothesis: text(item), confidence: '未評価' }).filter((item) => text((item as JsonRecord).hypothesis))
      : [];

  answer.answer_text = answerText;
  answer.executive_summary = executive;
  answer.explanatory_hypotheses = hypotheses;
  answer.cards = normalizeCards(baseCards, relatedCards);
  if (!isRecord(answer.quality_score) && answer.quality_score !== undefined) answer.quality_score = { overall: answer.quality_score, reason: 'quality_scoreを表示用に正規化' };
  if (!answer.quality_score && isRecord(answer.quality_rubric)) answer.quality_score = answer.quality_rubric;

  return { ...json, answer };
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

function stripReportInstruction(query: string) {
  return query.split('\n\n【レポート要件】')[0].trim() || query.trim();
}

function answerPreview(answer: unknown) {
  if (!isRecord(answer)) return '';
  const textValue = text(answer.answer_text || answer.summary || answer.report_title);
  return textValue.length > 220 ? `${textValue.slice(0, 220)}...` : textValue;
}

function reportTitleFromAnswer(answer: unknown) {
  return isRecord(answer) ? text(answer.report_title) : '';
}

function reportIdFromJson(json: unknown) {
  if (!isRecord(json) || !isRecord(json.report)) return '';
  return text(json.report.id);
}

function writeChatRunState(next: ChatRunState | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!next) window.sessionStorage.removeItem(CHAT_RUN_STORAGE_KEY);
    else window.sessionStorage.setItem(CHAT_RUN_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(CHAT_RUN_EVENT, { detail: next }));
  } catch {
    // State persistence must never break chat execution.
  }
}

function readChatRunState(): ChatRunState | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = safeJsonParse(window.sessionStorage.getItem(CHAT_RUN_STORAGE_KEY));
    if (parsed.status === 'running' || parsed.status === 'complete' || parsed.status === 'error') return parsed as ChatRunState;
    return null;
  } catch {
    return null;
  }
}

function patchFetch() {
  const original = window.fetch;
  if ((original as typeof window.fetch & { __chatPatched?: boolean }).__chatPatched) return () => undefined;

  const patched: typeof window.fetch & { __chatPatched?: boolean } = async (...args) => {
    const target = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
    if (!target.includes('/api/chat')) return original(...args);

    const init = args[1];
    const body = isRecord(init) ? init.body : undefined;
    const requestBody = safeJsonParse(body);
    const startedAt = Date.now();
    const baseRun: ChatRunState = {
      status: 'running',
      query: stripReportInstruction(text(requestBody.query) || currentQuery()),
      model: text(requestBody.model || selectedModel()),
      target_scope: text(requestBody.target_scope || selectedScope()),
      output_template: text(requestBody.output_template),
      started_at: startedAt,
      updated_at: startedAt
    };

    writeChatRunState(baseRun);

    try {
      const response = await original(...args);

      try {
        const clone = response.clone();
        const json = await clone.json();
        const normalized = normalizeChatJson(json);
        const normalizedRecord = isRecord(normalized) ? normalized : {};
        const answer = normalizedRecord.answer;
        const now = Date.now();

        if (response.ok) {
          writeChatRunState({
            ...baseRun,
            status: 'complete',
            updated_at: now,
            report_id: reportIdFromJson(normalizedRecord),
            report_title: reportTitleFromAnswer(answer),
            answer_preview: answerPreview(answer)
          });
        } else {
          writeChatRunState({
            ...baseRun,
            status: 'error',
            updated_at: now,
            error: text(normalizedRecord.error) || response.statusText || '分析に失敗しました'
          });
        }

        return new Response(JSON.stringify(normalized), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch {
        if (!response.ok) {
          writeChatRunState({ ...baseRun, status: 'error', updated_at: Date.now(), error: response.statusText || '分析に失敗しました' });
        }
        return response;
      }
    } catch (error) {
      writeChatRunState({
        ...baseRun,
        status: 'error',
        updated_at: Date.now(),
        error: error instanceof Error ? error.message : '分析に失敗しました'
      });
      throw error;
    }
  };

  patched.__chatPatched = true;
  window.fetch = patched;
  return () => { window.fetch = original; };
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
    '続行すると、gpt-5-nanoでスキャン後、gpt-5で最終レポートを作成します。',
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

function RunStatusCard({ run, onClear }: { run: ChatRunState; onClear: () => void }) {
  if (run.status === 'running') {
    return (
      <div className="card border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="font-bold">分析中です。ページ内で移動しても、この状態は保持されます。</p>
            <p className="mt-1">開始: {formatTime(run.started_at)} / モデル: {run.model || '不明'} / 対象: {run.target_scope || '不明'}</p>
            {run.query && <p className="mt-1 line-clamp-2">指示: {run.query}</p>}
            <p className="mt-1 text-xs">完了後は分析履歴にも保存されます。ブラウザの完全更新やタブ終了では通信が中断される場合があります。</p>
          </div>
          <Link className="btn shrink-0 bg-white" href="/reports">分析履歴</Link>
        </div>
      </div>
    );
  }

  if (run.status === 'complete') {
    return (
      <div className="card border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="font-bold">前回の分析が完了しました。</p>
            <p className="mt-1">完了: {formatTime(run.updated_at)}{run.report_title ? ` / ${run.report_title}` : ''}</p>
            {run.answer_preview && <p className="mt-1 line-clamp-2">{run.answer_preview}</p>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Link className="btn bg-white" href={run.report_id ? `/reports/${run.report_id}` : '/reports'}>開く</Link>
            <button className="btn bg-white" type="button" onClick={onClear}>閉じる</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="font-bold">前回の分析はエラーで終了しました。</p>
          <p className="mt-1">{run.error || '不明なエラー'}</p>
        </div>
        <button className="btn bg-white" type="button" onClick={onClear}>閉じる</button>
      </div>
    </div>
  );
}

export function ChatPanelModelOptionsPatch() {
  const [runState, setRunState] = useState<ChatRunState | null>(null);

  useEffect(() => {
    setRunState(readChatRunState());
    const restoreFetch = patchFetch();
    const onRunState = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as ChatRunState | null : readChatRunState();
      setRunState(detail || null);
    };
    const onClick = (event: MouseEvent) => {
      if (isSendButton(event.target)) confirmHighCost(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEnterSend(event)) confirmHighCost(event);
    };

    window.addEventListener(CHAT_RUN_EVENT, onRunState);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      restoreFetch();
      window.removeEventListener(CHAT_RUN_EVENT, onRunState);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  function clearRunState() {
    writeChatRunState(null);
    setRunState(null);
  }

  return (
    <div className="space-y-4">
      {runState && <RunStatusCard run={runState} onClear={clearRunState} />}
      <ChatPanel />
    </div>
  );
}

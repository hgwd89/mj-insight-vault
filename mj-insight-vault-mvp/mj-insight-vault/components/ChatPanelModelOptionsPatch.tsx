'use client';

import { useEffect } from 'react';
import { ChatPanel } from '@/components/ChatPanel';

const ALL_DATA_RE = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/;
const DEEP_RE = /本気|しっかり|詳細|深掘|深堀|高品質|レポート|インサイト|ナラティブ|構造|横断|説明仮説|仮説|調査|リサーチ|論点|WHY|why/;
const LIGHT_RE = /軽く|ざっくり|簡単|概要|一覧|傾向だけ|軽量|速報|まずは|ラフ/;

type JsonRecord = Record<string, unknown>;

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
    return {
      article_id: text(article.id),
      headline: text(article.headline || '記事'),
      article_date: text(article.article_date || '日付不明'),
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

function patchFetch() {
  const original = window.fetch;
  if ((original as typeof window.fetch & { __chatPatched?: boolean }).__chatPatched) return () => undefined;

  const patched: typeof window.fetch & { __chatPatched?: boolean } = async (...args) => {
    const response = await original(...args);
    const target = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
    if (!target.includes('/api/chat')) return response;

    try {
      const clone = response.clone();
      const json = await clone.json();
      const normalized = normalizeChatJson(json);
      return new Response(JSON.stringify(normalized), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch {
      return response;
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

export function ChatPanelModelOptionsPatch() {
  useEffect(() => {
    const restoreFetch = patchFetch();
    const onClick = (event: MouseEvent) => {
      if (isSendButton(event.target)) confirmHighCost(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEnterSend(event)) confirmHighCost(event);
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      restoreFetch();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  return <ChatPanel />;
}

'use client';

import { useEffect } from 'react';
import { ChatPanel } from '@/components/ChatPanel';

const ALL_DATA_RE = /全データ|全記事|今ある全|全部|トータル|全体傾向|全体|全件|すべて|全て/;
const DEEP_RE = /本気|しっかり|詳細|深掘|深堀|高品質|レポート|インサイト|ナラティブ|構造|横断|説明仮説|仮説|調査|リサーチ|論点|WHY|why/;
const LIGHT_RE = /軽く|ざっくり|簡単|概要|一覧|傾向だけ|軽量|速報|まずは|ラフ/;

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
  const text = el?.textContent?.trim() || '';
  return el && (text === '送信' || text === '分析中');
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
    const onClick = (event: MouseEvent) => {
      if (isSendButton(event.target)) confirmHighCost(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEnterSend(event)) confirmHighCost(event);
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  return <ChatPanel />;
}

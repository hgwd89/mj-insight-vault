'use client';

import { useEffect } from 'react';
import { ChatPanel } from '@/components/ChatPanel';

const MODELS = [
  { value: 'gpt-5', label: 'gpt-5｜本気レポート・高品質分析' },
  { value: 'gpt-5-mini', label: 'gpt-5-mini｜通常分析・軽めの傾向確認' },
  { value: 'gpt-5-nano', label: 'gpt-5-nano｜速報・粗い傾向確認' },
  { value: 'gpt-4.1', label: 'gpt-4.1｜旧標準' },
  { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini｜軽量' },
  { value: 'gpt-4o', label: 'gpt-4o｜旧高品質' },
  { value: 'gpt-4o-mini', label: 'gpt-4o-mini｜旧軽量' }
];

function fireReactChange(select: HTMLSelectElement) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, 'gpt-5');
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function patchModelSelect() {
  const labels = Array.from(document.querySelectorAll('label'));
  const modelLabel = labels.find((label) => label.textContent?.includes('APIモデル'));
  const select = modelLabel?.querySelector('select') as HTMLSelectElement | null;
  if (!select || select.dataset.modelPatched === 'true') return;

  select.innerHTML = '';

  for (const model of MODELS) {
    const option = document.createElement('option');
    option.value = model.value;
    option.textContent = model.label;
    select.appendChild(option);
  }

  select.dataset.modelPatched = 'true';
  fireReactChange(select);

  const help = modelLabel?.querySelector('p');
  if (help) {
    help.textContent = '本気レポートは gpt-5 を推奨。軽く傾向を見る場合だけ mini / nano / 旧モデルを使います。';
  }
}

export function ChatPanelModelOptionsPatch() {
  useEffect(() => {
    window.requestAnimationFrame(patchModelSelect);
  }, []);

  return <ChatPanel />;
}

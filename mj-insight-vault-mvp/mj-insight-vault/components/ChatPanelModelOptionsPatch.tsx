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

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function patchModelSelect() {
  const labels = Array.from(document.querySelectorAll('label'));
  const modelLabel = labels.find((label) => label.textContent?.includes('APIモデル'));
  const select = modelLabel?.querySelector('select') as HTMLSelectElement | null;
  if (!select) return;

  const currentValue = MODELS.some((model) => model.value === select.value) ? select.value : 'gpt-5';
  const currentOptions = Array.from(select.options).map((option) => option.value).join(',');
  const expectedOptions = MODELS.map((model) => model.value).join(',');

  if (currentOptions !== expectedOptions) {
    select.innerHTML = '';
    for (const model of MODELS) {
      const option = document.createElement('option');
      option.value = model.value;
      option.textContent = model.label;
      select.appendChild(option);
    }
  }

  if (!select.value || !MODELS.some((model) => model.value === select.value)) {
    setSelectValue(select, currentValue);
  }

  if (!select.value || select.value === 'gpt-4.1') {
    setSelectValue(select, 'gpt-5');
  }

  const help = modelLabel?.querySelector('p');
  if (help) {
    help.textContent = '本気レポートは gpt-5。軽く傾向を見る場合だけ mini / nano / 旧モデルを使います。';
  }
}

export function ChatPanelModelOptionsPatch() {
  useEffect(() => {
    patchModelSelect();
    const observer = new MutationObserver(() => patchModelSelect());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return <ChatPanel />;
}

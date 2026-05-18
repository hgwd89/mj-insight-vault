'use client';

import { useEffect } from 'react';
import { ChatPanel } from '@/components/ChatPanel';

const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'];

function patchModelSelect() {
  const labels = Array.from(document.querySelectorAll('label'));
  const modelLabel = labels.find((label) => label.textContent?.includes('APIモデル'));
  const select = modelLabel?.querySelector('select') as HTMLSelectElement | null;
  if (!select || select.dataset.modelPatched === 'true') return;

  const currentValue = select.value;
  const optionMap = new Map(Array.from(select.options).map((option) => [option.value, option]));
  select.innerHTML = '';

  for (const model of MODELS) {
    const option = optionMap.get(model) || document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }

  select.value = MODELS.includes(currentValue) ? currentValue : 'gpt-4.1';
  select.dataset.modelPatched = 'true';
}

export function ChatPanelModelOptionsPatch() {
  useEffect(() => {
    window.requestAnimationFrame(patchModelSelect);
  }, []);

  return <ChatPanel />;
}

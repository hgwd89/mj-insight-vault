'use client';

import { useEffect } from 'react';
import { ChatPanel } from '@/components/ChatPanel';

const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'];

function patchModelSelect() {
  const labels = Array.from(document.querySelectorAll('label'));
  const modelLabel = labels.find((label) => label.textContent?.includes('APIモデル'));
  const select = modelLabel?.querySelector('select') as HTMLSelectElement | null;
  if (!select) return;

  const currentValue = select.value;
  const existing = new Set(Array.from(select.options).map((option) => option.value));

  for (const model of MODELS) {
    if (!existing.has(model)) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      select.insertBefore(option, select.firstChild);
    }
  }

  const ordered = MODELS
    .map((model) => Array.from(select.options).find((option) => option.value === model))
    .filter(Boolean) as HTMLOptionElement[];
  for (const option of ordered.reverse()) {
    select.insertBefore(option, select.firstChild);
  }

  if (!MODELS.includes(currentValue) && select.value !== currentValue) select.value = currentValue;
}

export function ChatPanelModelOptionsPatch() {
  useEffect(() => {
    patchModelSelect();
    const observer = new MutationObserver(patchModelSelect);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(patchModelSelect, 1000);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, []);

  return <ChatPanel />;
}

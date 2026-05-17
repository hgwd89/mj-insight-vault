'use client';

import { useState } from 'react';

type Props = {
  value: string;
  onChange: (next: string) => void;
};

const fields = [
  { key: 'quote_candidates', label: '引用候補', placeholder: '短い引用・事実' },
  { key: 'consumer_change', label: '生活者変化', placeholder: '態度・行動・価値観の変化' },
  { key: 'business_implication', label: '企業示唆', placeholder: '企業・ブランド・流通への意味' },
  { key: 'research_hypothesis', label: '調査仮説', placeholder: '検証したい仮説・聞く論点' },
  { key: 'proposal_idea', label: '提案ネタ', placeholder: '提案に使える切り口' }
] as const;

function parseMemo(value: string) {
  if (!value.trim()) return {} as Record<string, unknown>;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { memo: value };
  } catch {
    return { memo: value };
  }
}

function stringifyMemo(value: Record<string, unknown>) {
  const cleaned = Object.fromEntries(
    Object.entries(value).filter(([, v]) => !(typeof v === 'string' && !v.trim()))
  );

  return JSON.stringify(cleaned, null, 2);
}

export function ArticleInsightMemo({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const memo = parseMemo(value);
  const memoCount = fields.filter((field) => typeof memo[field.key] === 'string' && (memo[field.key] as string).trim()).length;

  function updateField(key: string, nextValue: string) {
    onChange(stringifyMemo({ ...memo, [key]: nextValue }));
  }

  return (
    <section className="card p-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="font-bold">引用・示唆メモ</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-600">
            任意入力です。記事確認を優先するため通常は閉じています。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge">入力済み {memoCount}/{fields.length}</span>
          <button className="btn" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'メモを閉じる' : 'メモを開く'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {fields.map((field) => (
            <label key={field.key} className="block">
              <span className="text-sm font-bold text-zinc-700">{field.label}</span>
              <textarea
                className="input mt-2 min-h-16 text-sm"
                value={typeof memo[field.key] === 'string' ? memo[field.key] as string : ''}
                onChange={(e) => updateField(field.key, e.target.value)}
                placeholder={field.placeholder}
              />
            </label>
          ))}
        </div>
      )}
    </section>
  );
}

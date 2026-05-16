'use client';

type Props = {
  value: string;
  onChange: (next: string) => void;
};

const fields = [
  { key: 'quote_candidates', label: '引用候補', placeholder: '記事本文から使えそうな短い引用・事実を書き留める' },
  { key: 'consumer_change', label: '生活者変化', placeholder: '生活者の態度・行動・価値観の変化' },
  { key: 'business_implication', label: '企業示唆', placeholder: '企業・ブランド・流通にとっての意味' },
  { key: 'research_hypothesis', label: '調査仮説', placeholder: '検証したい仮説・聞くべき論点' },
  { key: 'proposal_idea', label: '提案ネタ', placeholder: '提案書に使える切り口・タイトル案' }
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
  const memo = parseMemo(value);

  function updateField(key: string, nextValue: string) {
    onChange(stringifyMemo({ ...memo, [key]: nextValue }));
  }

  return (
    <section className="card p-5">
      <h2 className="font-bold">引用・示唆メモ</h2>
      <p className="mt-1 text-sm leading-6 text-zinc-600">
        記事を後で分析に使うための手動メモです。保存すると manual_analysis JSON に入ります。
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {fields.map((field) => (
          <label key={field.key} className="block">
            <span className="text-sm font-bold text-zinc-700">{field.label}</span>
            <textarea
              className="input mt-2 min-h-28"
              value={typeof memo[field.key] === 'string' ? memo[field.key] as string : ''}
              onChange={(e) => updateField(field.key, e.target.value)}
              placeholder={field.placeholder}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

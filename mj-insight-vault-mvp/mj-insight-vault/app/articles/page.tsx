'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/components/DataHooks';

type Article = { id: string; headline: string | null; ocr_text: string | null; article_type: string; has_table: boolean; has_chart: boolean; created_at: string; article_tags?: { tag_type: string; tag_name: string }[] };

export default function ArticlesPage() {
  const [q, setQ] = useState('');
  const { data, error, loading } = useApi<{ articles: Article[] }>(`/api/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-black">記事一覧</h1>
        <input className="input mt-4" value={q} onChange={(e) => setQ(e.target.value)} placeholder="見出し・本文検索" />
      </div>
      {loading && <div className="card p-5">読み込み中</div>}
      {error && <div className="card p-5 text-red-600">{error}</div>}
      <div className="grid gap-3">
        {(data?.articles || []).map((a) => (
          <Link key={a.id} href={`/articles/${a.id}`} className="card p-4 hover:border-zinc-400">
            <p className="font-bold">{a.headline || '無題の記事候補'}</p>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600">{a.ocr_text}</p>
            <div className="mt-3 flex flex-wrap gap-2"><span className="badge">{a.article_type}</span>{a.has_table && <span className="badge">表</span>}{a.has_chart && <span className="badge">図表</span>}{(a.article_tags || []).map((t) => <span key={`${t.tag_type}-${t.tag_name}`} className="badge">{t.tag_name}</span>)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

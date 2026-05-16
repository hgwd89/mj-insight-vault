'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type Article = {
  id: string;
  headline: string | null;
  article_date?: string | null;
  ocr_text: string | null;
  article_type: string;
  has_table: boolean;
  has_chart: boolean;
  created_at: string;
  status?: string | null;
  article_tags?: { tag_type: string; tag_name: string }[];
};

type FilterKind = 'all' | 'duplicate' | 'date_unknown' | 'needs_review' | 'has_table_chart';

const deleteReasons = ['重複', 'OCR崩れ', '広告', '対象外', '誤抽出', 'その他'];
const bulkTagTypes = ['industry', 'consumer_pressure', 'behavior_change', 'method_fit', 'custom_theme'];

function duplicateKey(article: Article) {
  const base = `${article.headline || ''} ${(article.ocr_text || '').slice(0, 500)}`
    .replace(/[\s\n\r\t　、。・「」『』（）()【】\[\]{}]/g, '')
    .toLowerCase();

  return base.slice(0, 160);
}

function isDateUnknown(article: Article) {
  return !article.article_date || article.article_date === '日付不明';
}

export default function ArticlesPage() {
  const password = useAppPassword();
  const [q, setQ] = useState('');
  const [filterKind, setFilterKind] = useState<FilterKind>('all');

  const { data, error, loading } = useApi<{ articles: Article[] }>(
    `/api/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`
  );

  const [articles, setArticles] = useState<Article[]>([]);
  const [busyId, setBusyId] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkReason, setBulkReason] = useState('重複');
  const [bulkDate, setBulkDate] = useState('');
  const [bulkTagType, setBulkTagType] = useState('custom_theme');
  const [bulkTagName, setBulkTagName] = useState('');

  useEffect(() => {
    if (data?.articles) {
      setArticles(data.articles.filter((a) => a.status !== 'deleted'));
      setSelectedIds(new Set());
    }
  }, [data]);

  const duplicateIds = useMemo(() => {
    const groups = new Map<string, string[]>();

    for (const article of articles) {
      const key = duplicateKey(article);
      if (key.length < 40) continue;
      groups.set(key, [...(groups.get(key) || []), article.id]);
    }

    const ids = new Set<string>();
    for (const group of groups.values()) {
      if (group.length > 1) group.forEach((id) => ids.add(id));
    }

    return ids;
  }, [articles]);

  const visibleArticles = useMemo(() => {
    return articles.filter((article) => {
      if (filterKind === 'duplicate') return duplicateIds.has(article.id);
      if (filterKind === 'date_unknown') return isDateUnknown(article);
      if (filterKind === 'needs_review') return article.status === 'needs_review';
      if (filterKind === 'has_table_chart') return article.has_table || article.has_chart;
      return true;
    });
  }, [articles, duplicateIds, filterKind]);

  const visibleIds = useMemo(() => visibleArticles.map((a) => a.id), [visibleArticles]);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;

  function toggleSelected(articleId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
  }

  function selectVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function runBulk(action: 'delete' | 'set_date' | 'set_status' | 'add_tags', extra: Record<string, unknown> = {}) {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;

    const ok = window.confirm(`${ids.length}件に一括処理します。実行してよいですか。`);
    if (!ok) return;

    setBulkBusy(true);

    try {
      const res = await fetch('/api/articles/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ action, article_ids: ids, ...extra })
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '一括処理に失敗しました');

      if (action === 'delete') {
        setArticles((prev) => prev.filter((a) => !selectedIds.has(a.id)));
      }

      if (action === 'set_date') {
        const nextDate = String(extra.article_date || '');
        setArticles((prev) => prev.map((a) => selectedIds.has(a.id) ? { ...a, article_date: nextDate || null } : a));
      }

      if (action === 'set_status') {
        const nextStatus = String(extra.status || 'ocr_done');
        setArticles((prev) => prev.map((a) => selectedIds.has(a.id) ? { ...a, status: nextStatus } : a));
      }

      if (action === 'add_tags') {
        const tags = Array.isArray(extra.tags) ? extra.tags as { tag_type: string; tag_name: string }[] : [];
        setArticles((prev) => prev.map((a) => {
          if (!selectedIds.has(a.id)) return a;
          const current = a.article_tags || [];
          const merged = [...current];
          for (const tag of tags) {
            if (!merged.some((t) => t.tag_type === tag.tag_type && t.tag_name === tag.tag_name)) merged.push(tag);
          }
          return { ...a, article_tags: merged };
        }));
      }

      clearSelection();
    } catch (error) {
      alert(error instanceof Error ? error.message : '一括処理に失敗しました');
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteArticle(articleId: string) {
    const reason = reasonById[articleId] || '重複';
    const ok = window.confirm(
      `この記事を不要記事にします。理由: ${reason}\n物理削除ではなく status=deleted にして、一覧・分析対象から外します。`
    );

    if (!ok) return;

    setBusyId(articleId);

    try {
      const res = await fetch(`/api/articles/${articleId}?reason=${encodeURIComponent(reason)}`, {
        method: 'DELETE',
        headers: {
          'x-app-password': password
        }
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || '削除に失敗しました');
      }

      setArticles((prev) => prev.filter((a) => a.id !== articleId));
    } catch (error) {
      alert(error instanceof Error ? error.message : '削除に失敗しました');
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-black">記事一覧</h1>
            <p className="mt-2 text-sm text-zinc-600">重複・ノイズ記事は「不要記事」で分析対象から外せます。複数選択して一括整理できます。</p>
          </div>
          <Link className="btn" href="/articles/deleted">不要記事一覧</Link>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_220px]">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="見出し・本文検索"
          />

          <select className="input" value={filterKind} onChange={(e) => setFilterKind(e.target.value as FilterKind)}>
            <option value="all">すべて</option>
            <option value="duplicate">重複候補</option>
            <option value="date_unknown">日付不明</option>
            <option value="needs_review">要確認</option>
            <option value="has_table_chart">表・図表あり</option>
          </select>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-600">
          <span className="badge">表示 {visibleArticles.length}</span>
          <span className="badge">全体 {articles.length}</span>
          <span className="badge">重複候補 {duplicateIds.size}</span>
          <span className="badge">日付不明 {articles.filter(isDateUnknown).length}</span>
          <span className="badge">選択 {selectedIds.size}</span>
        </div>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap gap-2">
          <button className="btn" type="button" onClick={selectVisible} disabled={!visibleArticles.length || bulkBusy}>表示中を全選択</button>
          <button className="btn" type="button" onClick={clearSelection} disabled={!selectedIds.size || bulkBusy}>選択解除</button>
          <button className="btn border-amber-300 text-amber-700 hover:bg-amber-50" type="button" onClick={() => runBulk('set_status', { status: 'needs_review' })} disabled={!selectedIds.size || bulkBusy}>要確認にする</button>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-[160px_auto_1fr_auto]">
          <select className="input" value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} disabled={bulkBusy}>
            {deleteReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select>
          <button className="btn border-red-300 text-red-600 hover:bg-red-50" type="button" onClick={() => runBulk('delete', { reason: bulkReason })} disabled={!selectedIds.size || bulkBusy}>一括不要化</button>

          <input className="input" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} placeholder="一括日付補正：例 2026-05-13" disabled={bulkBusy} />
          <button className="btn" type="button" onClick={() => runBulk('set_date', { article_date: bulkDate })} disabled={!selectedIds.size || bulkBusy}>日付反映</button>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-[180px_1fr_auto]">
          <select className="input" value={bulkTagType} onChange={(e) => setBulkTagType(e.target.value)} disabled={bulkBusy}>
            {bulkTagTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <input className="input" value={bulkTagName} onChange={(e) => setBulkTagName(e.target.value)} placeholder="一括タグ名：例 推し活 / 食品 / N1向き" disabled={bulkBusy} />
          <button className="btn" type="button" onClick={() => runBulk('add_tags', { tags: [{ tag_type: bulkTagType, tag_name: bulkTagName }] })} disabled={!selectedIds.size || !bulkTagName.trim() || bulkBusy}>タグ付与</button>
        </div>
      </div>

      {loading && <div className="card p-5">読み込み中</div>}
      {error && <div className="card p-5 text-red-600">{error}</div>}

      <div className="grid gap-3">
        {visibleArticles.length === 0 && !loading && !error && (
          <div className="card p-5 text-sm text-zinc-500">
            表示できる記事がありません。
          </div>
        )}

        {visibleArticles.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="flex min-w-0 flex-1 gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={selectedIds.has(a.id)}
                  onChange={() => toggleSelected(a.id)}
                  aria-label="記事を選択"
                />
                <Link href={`/articles/${a.id}`} className="min-w-0 flex-1 hover:opacity-80">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-bold">
                      {a.headline || '無題の記事候補'}
                    </p>
                    <span className="badge">{a.article_date || '日付不明'}</span>
                    {duplicateIds.has(a.id) && (
                      <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700">重複候補</span>
                    )}
                  </div>

                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600">
                    {a.ocr_text}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="badge">{a.article_type}</span>
                    <span className="badge">{a.status || 'ocr_done'}</span>
                    {a.has_table && <span className="badge">表</span>}
                    {a.has_chart && <span className="badge">図表</span>}
                    {(a.article_tags || []).map((t) => (
                      <span key={`${t.tag_type}-${t.tag_name}`} className="badge">
                        {t.tag_name}
                      </span>
                    ))}
                  </div>
                </Link>
              </div>

              <div className="flex shrink-0 flex-col gap-2 md:w-40">
                <select
                  className="input text-sm"
                  value={reasonById[a.id] || '重複'}
                  onChange={(e) => setReasonById((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  disabled={busyId === a.id}
                >
                  {deleteReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                </select>
                <button
                  className="btn border-red-300 text-red-600 hover:bg-red-50"
                  onClick={() => deleteArticle(a.id)}
                  disabled={busyId === a.id}
                >
                  {busyId === a.id ? '処理中' : '不要記事'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

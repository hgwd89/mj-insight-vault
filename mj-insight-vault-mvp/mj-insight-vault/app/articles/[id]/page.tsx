'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';
import { useApi } from '@/components/DataHooks';
import { ArticleInsightMemo } from '@/components/ArticleInsightMemo';

type ArticleTag = {
  id?: string;
  tag_type: string;
  tag_name: string;
};

type TagMaster = {
  id: string;
  tag_type: string;
  tag_name: string;
  description: string | null;
};

type Article = {
  id: string;
  batch_id: string;
  headline: string | null;
  article_date?: string | null;
  ocr_text: string | null;
  status: string;
  article_type: string;
  has_table: boolean;
  has_chart: boolean;
  has_image: boolean;
  manual_analysis: Record<string, unknown> | null;
  source_images?: { id: string; storage_path: string; file_name: string; mime_type?: string | null };
  article_tags?: ArticleTag[];
};

const tagTypes = ['industry', 'consumer_pressure', 'behavior_change', 'method_fit', 'custom_theme'];

function tagKey(tag: { tag_type: string; tag_name: string }) {
  return `${tag.tag_type}::${tag.tag_name}`;
}

export default function ArticleDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const password = useAppPassword();

  const { data, error, loading } = useApi<{ article: Article }>(`/api/articles/${params.id}`);

  const [headline, setHeadline] = useState('');
  const [articleDate, setArticleDate] = useState('');
  const [analysisText, setAnalysisText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [tagMaster, setTagMaster] = useState<TagMaster[]>([]);
  const [selectedTags, setSelectedTags] = useState<ArticleTag[]>([]);
  const [customTagType, setCustomTagType] = useState('custom_theme');
  const [customTagName, setCustomTagName] = useState('');
  const [reprocessBusy, setReprocessBusy] = useState(false);

  useEffect(() => {
    if (data?.article) {
      setHeadline(data.article.headline || '');
      setArticleDate(data.article.article_date || '');
      setStatus(data.article.status);
      setSelectedTags(data.article.article_tags || []);
      setAnalysisText(
        data.article.manual_analysis
          ? JSON.stringify(data.article.manual_analysis, null, 2)
          : ''
      );

      const path = data.article.source_images?.storage_path;

      if (path) {
        fetch(`/api/signed-url?path=${encodeURIComponent(path)}`, {
          headers: { 'x-app-password': password }
        })
          .then((r) => r.json())
          .then((j) => setImageUrl(j.url || ''));
      }
    }
  }, [data, password]);

  useEffect(() => {
    fetch('/api/tags', { headers: { 'x-app-password': password } })
      .then((r) => r.json())
      .then((j) => setTagMaster(j.tags || []))
      .catch(() => setTagMaster([]));
  }, [password]);

  function toggleTag(tag: ArticleTag) {
    const key = tagKey(tag);
    setSelectedTags((prev) => {
      if (prev.some((t) => tagKey(t) === key)) {
        return prev.filter((t) => tagKey(t) !== key);
      }

      return [...prev, { tag_type: tag.tag_type, tag_name: tag.tag_name }];
    });
  }

  function addCustomTag() {
    const tagName = customTagName.trim();
    if (!tagName) return;

    const tag = { tag_type: customTagType, tag_name: tagName };
    const key = tagKey(tag);

    setSelectedTags((prev) => {
      if (prev.some((t) => tagKey(t) === key)) return prev;
      return [...prev, tag];
    });

    setCustomTagName('');
  }

  async function save() {
    let manual_analysis: Record<string, unknown> | null = null;

    if (analysisText.trim()) {
      try {
        manual_analysis = JSON.parse(analysisText);
      } catch {
        manual_analysis = { memo: analysisText };
      }
    }

    const res = await fetch(`/api/articles/${params.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-app-password': password
      },
      body: JSON.stringify({
        headline,
        article_date: articleDate.trim() || null,
        status,
        manual_analysis,
        article_tags: selectedTags.map((tag) => ({ tag_type: tag.tag_type, tag_name: tag.tag_name }))
      })
    });

    if (!res.ok) {
      alert('保存に失敗しました');
    } else {
      alert('保存しました');
    }
  }

  async function deleteArticle() {
    const ok = window.confirm(
      'この記事を不要記事にします。物理削除ではなく status=deleted にして、分析対象から外します。'
    );

    if (!ok) return;

    setBusy(true);

    try {
      const res = await fetch(`/api/articles/${params.id}`, {
        method: 'DELETE',
        headers: {
          'x-app-password': password
        }
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || '削除に失敗しました');
      }

      setStatus('deleted');
      alert('不要記事にしました');
      router.back();
    } catch (error) {
      alert(error instanceof Error ? error.message : '削除に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  async function reprocessSourceImage() {
    const imageId = data?.article.source_images?.id;
    if (!imageId) return;

    const ok = window.confirm(
      'この元画像を再OCR・再構造化します。同じ元画像から作った既存記事は不要記事になり、新しい記事候補が作られます。'
    );

    if (!ok) return;

    setReprocessBusy(true);

    try {
      const res = await fetch(`/api/source-images/${imageId}/reprocess`, {
        method: 'POST',
        headers: { 'x-app-password': password }
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '再処理に失敗しました');

      alert(`再処理しました。新しい記事候補: ${json.article_count || 0}件`);
      router.push(`/batches/${data!.article.batch_id}`);
    } catch (error) {
      alert(error instanceof Error ? error.message : '再処理に失敗しました');
    } finally {
      setReprocessBusy(false);
    }
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;

  const article = data!.article;
  const groupedTagMaster = tagMaster.reduce<Record<string, TagMaster[]>>((acc, tag) => {
    acc[tag.tag_type] ||= [];
    acc[tag.tag_type].push(tag);
    return acc;
  }, {});
  const selectedKeys = new Set(selectedTags.map(tagKey));

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <p className="text-sm text-zinc-500">記事ID：{article.id}</p>

        <input
          className="input mt-3 text-lg font-bold"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
        />

        <label className="mt-3 block max-w-sm">
          <span className="text-sm font-bold text-zinc-700">記事日付</span>
          <input
            className="input mt-2"
            value={articleDate}
            onChange={(e) => setArticleDate(e.target.value)}
            placeholder="例: 2026-05-13 / 5月13日 / 日付不明"
          />
        </label>

        <div className="mt-3 flex flex-wrap gap-2">
          <span className="badge">{article.article_type}</span>
          <span className="badge">{articleDate || '日付不明'}</span>
          {article.has_table && <span className="badge">表</span>}
          {article.has_chart && <span className="badge">図表</span>}
          {article.has_image && <span className="badge">画像</span>}
          {selectedTags.map((t) => (
            <button key={tagKey(t)} className="badge" onClick={() => toggleTag(t)} type="button">
              {t.tag_name} ×
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <select
            className="input max-w-xs"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="ocr_done">OCR完了</option>
            <option value="needs_review">要確認</option>
            <option value="analyzed">分析済み</option>
            <option value="deleted">不要記事</option>
          </select>

          <button className="btn btn-primary" onClick={save} disabled={busy || reprocessBusy}>
            保存
          </button>

          <button
            className="btn border-red-300 text-red-600 hover:bg-red-50"
            onClick={deleteArticle}
            disabled={busy || reprocessBusy || status === 'deleted'}
          >
            {status === 'deleted' ? '不要記事済み' : '不要記事にする'}
          </button>

          {article.source_images?.id && (
            <button
              className="btn border-amber-300 text-amber-700 hover:bg-amber-50"
              onClick={reprocessSourceImage}
              disabled={busy || reprocessBusy}
            >
              {reprocessBusy ? '再処理中' : '元画像を再OCR'}
            </button>
          )}
        </div>
      </div>

      <section className="card p-5">
        <h2 className="font-bold">手動タグ</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-600">
          分析時の絞り込み・解釈軸に使うタグです。保存ボタンで反映します。
        </p>

        <div className="mt-4 grid gap-4">
          {Object.entries(groupedTagMaster).map(([type, tags]) => (
            <div key={type}>
              <p className="text-sm font-bold text-zinc-700">{type}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {tags.map((tag) => {
                  const checked = selectedKeys.has(tagKey(tag));
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={checked ? 'btn btn-primary' : 'btn'}
                      onClick={() => toggleTag(tag)}
                    >
                      {tag.tag_name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 grid gap-2 md:grid-cols-[180px_1fr_auto]">
          <select className="input" value={customTagType} onChange={(e) => setCustomTagType(e.target.value)}>
            {tagTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <input
            className="input"
            value={customTagName}
            onChange={(e) => setCustomTagName(e.target.value)}
            placeholder="カスタムタグ名"
          />
          <button className="btn" type="button" onClick={addCustomTag} disabled={!customTagName.trim()}>
            タグ追加
          </button>
        </div>
      </section>

      <ArticleInsightMemo value={analysisText} onChange={setAnalysisText} />

      {imageUrl && (
        <div className="card p-5">
          <h2 className="font-bold">元画像</h2>
          <img
            src={imageUrl}
            alt="元画像"
            className="mt-3 max-h-[70vh] rounded-xl border object-contain"
          />
        </div>
      )}

      <section className="card p-5">
        <h2 className="font-bold">OCR本文</h2>
        <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm leading-7">
          {article.ocr_text}
        </pre>
      </section>

      <section className="card p-5">
        <h2 className="font-bold">手修正用 分析メモJSON</h2>
        <p className="mt-1 text-sm text-zinc-600">
          上の引用・示唆メモと同じ内容です。直接JSON編集もできます。
        </p>

        <textarea
          className="input mt-3 min-h-64 font-mono"
          value={analysisText}
          onChange={(e) => setAnalysisText(e.target.value)}
          placeholder='{"research_issue":"..."}'
        />
      </section>
    </div>
  );
}

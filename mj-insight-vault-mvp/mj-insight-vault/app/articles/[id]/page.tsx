'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';
import { useApi } from '@/components/DataHooks';

type Article = {
  id: string;
  headline: string | null;
  ocr_text: string | null;
  status: string;
  article_type: string;
  has_table: boolean;
  has_chart: boolean;
  has_image: boolean;
  manual_analysis: Record<string, unknown> | null;
  source_images?: { storage_path: string; file_name: string };
  article_tags?: { tag_type: string; tag_name: string }[];
};

export default function ArticleDetailPage() {
  const params = useParams<{ id: string }>();
  const password = useAppPassword();
  const { data, error, loading } = useApi<{ article: Article }>(`/api/articles/${params.id}`);
  const [headline, setHeadline] = useState('');
  const [analysisText, setAnalysisText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (data?.article) {
      setHeadline(data.article.headline || '');
      setStatus(data.article.status);
      setAnalysisText(data.article.manual_analysis ? JSON.stringify(data.article.manual_analysis, null, 2) : '');
      const path = data.article.source_images?.storage_path;
      if (path) {
        fetch(`/api/signed-url?path=${encodeURIComponent(path)}`, { headers: { 'x-app-password': password } })
          .then((r) => r.json())
          .then((j) => setImageUrl(j.url || ''));
      }
    }
  }, [data, password]);

  async function save() {
    let manual_analysis: Record<string, unknown> | null = null;
    if (analysisText.trim()) {
      try { manual_analysis = JSON.parse(analysisText); } catch { manual_analysis = { memo: analysisText }; }
    }
    const res = await fetch(`/api/articles/${params.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-app-password': password },
      body: JSON.stringify({ headline, status, manual_analysis })
    });
    if (!res.ok) alert('保存に失敗しました'); else alert('保存しました');
  }

  if (loading) return <div className="card p-5">読み込み中</div>;
  if (error) return <div className="card p-5 text-red-600">{error}</div>;
  const article = data!.article;
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <p className="text-sm text-zinc-500">記事ID：{article.id}</p>
        <input className="input mt-3 text-lg font-bold" value={headline} onChange={(e) => setHeadline(e.target.value)} />
        <div className="mt-3 flex flex-wrap gap-2"><span className="badge">{article.article_type}</span>{article.has_table && <span className="badge">表</span>}{article.has_chart && <span className="badge">図表</span>}{article.has_image && <span className="badge">画像</span>}{(article.article_tags || []).map((t) => <span key={`${t.tag_type}-${t.tag_name}`} className="badge">{t.tag_name}</span>)}</div>
        <div className="mt-4 flex gap-2">
          <select className="input max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="ocr_done">OCR完了</option>
            <option value="needs_review">要確認</option>
            <option value="analyzed">分析済み</option>
          </select>
          <button className="btn btn-primary" onClick={save}>保存</button>
        </div>
      </div>
      {imageUrl && <div className="card p-5"><h2 className="font-bold">元画像</h2><img src={imageUrl} alt="元画像" className="mt-3 max-h-[70vh] rounded-xl border object-contain" /></div>}
      <section className="card p-5">
        <h2 className="font-bold">OCR本文</h2>
        <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 text-sm leading-7">{article.ocr_text}</pre>
      </section>
      <section className="card p-5">
        <h2 className="font-bold">手修正用 分析メモJSON</h2>
        <p className="mt-1 text-sm text-zinc-600">チャット分析結果から転記・修正したい内容を保存できます。</p>
        <textarea className="input mt-3 min-h-64 font-mono" value={analysisText} onChange={(e) => setAnalysisText(e.target.value)} placeholder='{"research_issue":"..."}' />
      </section>
    </div>
  );
}

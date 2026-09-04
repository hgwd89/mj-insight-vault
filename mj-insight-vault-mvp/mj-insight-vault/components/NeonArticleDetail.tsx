'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useAppPassword } from '@/components/PasswordGate';

type Article = {
  id: string;
  source_file_id: string;
  title: string;
  text: string;
  article_date?: string | null;
  source_file_name?: string | null;
  source_mime_type?: string | null;
  source_file_size_bytes?: number | null;
  drive_file_id?: string | null;
  original_available?: boolean;
  verification_status?: string | null;
};

type Section = {
  title: string;
  lines: string[];
};

const TITLE_MAP: Record<string, string> = {
  '本文再構成': '本文',
  '主要事実': '主要事実',
  '固有名詞': '登場する企業・ブランド・人物',
  '数字・根拠': '数字・根拠',
  '図表': '図表',
  '発言・記事内主張': '発言・記事内主張'
};

const HIDDEN = new Set(['GPT記事構造化', '除外ノイズ', 'OCR照合メモ']);

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(json.error || `HTTP ${res.status}`));
  return json;
}

function formatDate(value?: string | null) {
  if (!value) return '日付未設定';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

function formatBytes(value?: number | null) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: '本文', lines: [] };
  let hidden = false;

  const push = () => {
    const lines = current.lines.map((line) => line.trim()).filter(Boolean);
    if (lines.length) sections.push({ ...current, lines });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const marker = line.match(/^【([^】]+)】(.*)$/);
    if (marker) {
      const key = marker[1].trim();
      if (key === '全体信頼度') continue;
      push();
      hidden = HIDDEN.has(key);
      current = { title: TITLE_MAP[key] || key, lines: [] };
      const inline = marker[2].trim();
      if (inline && !hidden) current.lines.push(inline);
      continue;
    }
    if (!hidden && line) current.lines.push(line);
  }
  push();

  return sections.filter((section) => section.title !== 'GPT記事構造化');
}

export function NeonArticleDetail({ articleId }: { articleId: string }) {
  const appPassword = useAppPassword();
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalError, setOriginalError] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [originalMimeType, setOriginalMimeType] = useState('');

  useEffect(() => {
    if (!appPassword || !articleId) return;
    void (async () => {
      try {
        const auth = await fetch('/api/cloud-stock/auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
          body: JSON.stringify({ action: 'auto' })
        });
        await readJson(auth);
        const res = await fetch(`/api/cloud-stock/articles/${encodeURIComponent(articleId)}`, {
          headers: { 'x-app-password': appPassword },
          cache: 'no-store'
        });
        const json = await readJson(res);
        setArticle(json.article as Article);
      } catch (err) {
        setError(err instanceof Error ? err.message : '記事を取得できませんでした。');
      } finally {
        setLoading(false);
      }
    })();
  }, [appPassword, articleId]);

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
    };
  }, [originalUrl]);

  const sections = useMemo(() => parseSections(article?.text || ''), [article?.text]);

  async function showOriginal() {
    if (!article?.source_file_id || !appPassword) return;
    setOriginalLoading(true);
    setOriginalError('');
    try {
      const res = await fetch(`/api/cloud-stock/files/${encodeURIComponent(article.source_file_id)}/content`, {
        headers: { 'x-app-password': appPassword },
        cache: 'no-store'
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(String(json.error || `HTTP ${res.status}`));
      }
      const blob = await res.blob();
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      setOriginalMimeType(blob.type || article.source_mime_type || 'application/octet-stream');
      setOriginalUrl(URL.createObjectURL(blob));
    } catch (err) {
      setOriginalError(err instanceof Error ? err.message : '原本を表示できませんでした。');
    } finally {
      setOriginalLoading(false);
    }
  }

  if (loading) {
    return <div className="card p-6 text-sm font-semibold text-zinc-600">記事を読み込んでいます…</div>;
  }

  if (!article) {
    return (
      <div className="card p-6">
        <p className="font-bold text-red-700">{error || '記事が見つかりません。'}</p>
        <Link className="btn mt-4 inline-flex items-center gap-2" href="/cloud-stock"><ArrowLeft className="h-4 w-4" />記事一覧へ戻る</Link>
      </div>
    );
  }

  const driveUrl = article.drive_file_id ? `https://drive.google.com/file/d/${encodeURIComponent(article.drive_file_id)}/view` : '';
  const isImage = originalMimeType.startsWith('image/');
  const isPdf = originalMimeType === 'application/pdf';

  return (
    <article className="mx-auto max-w-4xl">
      <Link className="mb-4 inline-flex items-center gap-2 text-sm font-bold text-zinc-600 hover:text-zinc-900" href="/cloud-stock">
        <ArrowLeft className="h-4 w-4" />記事一覧へ戻る
      </Link>

      <header className="card p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-bold">{formatDate(article.article_date)}</span>
          {article.source_file_name && <span>{article.source_file_name}</span>}
          {formatBytes(article.source_file_size_bytes) && <span>{formatBytes(article.source_file_size_bytes)}</span>}
        </div>
        <h1 className="mt-4 text-xl font-black leading-9 text-zinc-950 sm:text-3xl sm:leading-[1.45]">{article.title}</h1>
      </header>

      <section className="card mt-4 p-5 sm:p-7">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-black text-zinc-900 sm:text-lg">原本</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">
              {article.source_file_name || '原本ファイル'}を記事に紐づけて表示します。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {article.original_available && (
              <button className="btn" type="button" onClick={() => void showOriginal()} disabled={originalLoading}>
                {originalLoading ? '原本を読込中…' : originalUrl ? '原本を再読込' : '原本を表示'}
              </button>
            )}
            {driveUrl && (
              <a className="btn inline-flex items-center gap-2" href={driveUrl} target="_blank" rel="noreferrer">
                Google Driveで開く <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </div>
        </div>

        {!article.original_available && (
          <p className="mt-3 text-sm font-semibold text-amber-700">この記事にはGoogle Drive原本が紐づいていません。</p>
        )}
        {originalError && <p className="mt-3 text-sm font-semibold text-red-700">{originalError}</p>}

        {originalUrl && (
          <div className="mt-4 overflow-hidden rounded-xl border bg-zinc-50">
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={originalUrl} alt="記事原本" className="mx-auto max-h-[80vh] w-auto max-w-full object-contain" />
            ) : isPdf ? (
              <iframe src={originalUrl} title="記事原本PDF" className="h-[78vh] w-full bg-white" />
            ) : (
              <div className="p-5">
                <p className="text-sm text-zinc-600">このファイル形式はアプリ内プレビューに対応していません。</p>
                <a className="btn mt-3 inline-flex" href={originalUrl} target="_blank" rel="noreferrer">原本を別タブで開く</a>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="mt-4 space-y-4">
        {sections.map((section, index) => (
          <section key={`${section.title}-${index}`} className="card p-5 sm:p-7">
            {section.title !== '本文' || index > 0 ? (
              <h2 className="mb-4 text-base font-black text-zinc-900 sm:text-lg">{section.title}</h2>
            ) : null}
            <div className="space-y-3 text-[15px] leading-8 text-zinc-800 sm:text-base sm:leading-8">
              {section.lines.map((line, lineIndex) => line.startsWith('- ') ? (
                <div key={lineIndex} className="flex gap-2">
                  <span className="mt-[1px] shrink-0">•</span>
                  <p>{line.slice(2)}</p>
                </div>
              ) : (
                <p key={lineIndex}>{line}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

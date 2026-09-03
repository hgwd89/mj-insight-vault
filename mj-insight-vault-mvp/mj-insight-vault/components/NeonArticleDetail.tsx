'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useAppPassword } from '@/components/PasswordGate';

type Article = {
  id: string;
  title: string;
  text: string;
  article_date?: string | null;
  source_file_name?: string | null;
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

  const sections = useMemo(() => parseSections(article?.text || ''), [article?.text]);

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

  return (
    <article className="mx-auto max-w-3xl">
      <Link className="mb-4 inline-flex items-center gap-2 text-sm font-bold text-zinc-600 hover:text-zinc-900" href="/cloud-stock">
        <ArrowLeft className="h-4 w-4" />記事一覧へ戻る
      </Link>

      <header className="card p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-bold">{formatDate(article.article_date)}</span>
          {article.source_file_name && <span>{article.source_file_name}</span>}
        </div>
        <h1 className="mt-4 text-xl font-black leading-9 text-zinc-950 sm:text-3xl sm:leading-[1.45]">{article.title}</h1>
      </header>

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

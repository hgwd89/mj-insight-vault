'use client';

import Link from 'next/link';
import { ReactNode, useMemo } from 'react';

type ArticleRef = {
  id: string;
  headline?: string | null;
  article_date?: string | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const textTokenPattern = /(\[[^\]]+\]\([^)]+\)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const markdownLinkPattern = /^\[([^\]]+)\]\(([^)]+)\)$/;

function articleLabel(article: ArticleRef) {
  return `${article.headline || '無題の記事'}｜${article.article_date || '日付不明'}`;
}

function internalArticleHref(href: string) {
  if (href.startsWith('/articles/')) return href;
  try {
    const url = new URL(href);
    return url.pathname.startsWith('/articles/') ? url.pathname : '';
  } catch {
    return '';
  }
}

export function MarkdownArticleText({ text, articles, className }: { text: string; articles: ArticleRef[]; className?: string }) {
  const articleMap = useMemo(() => new Map(articles.map((article) => [article.id, article])), [articles]);
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(textTokenPattern)) {
    const token = match[0];
    const index = match.index || 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));

    const markdownLink = token.match(markdownLinkPattern);
    if (markdownLink) {
      const label = markdownLink[1];
      const href = internalArticleHref(markdownLink[2]);
      nodes.push(href
        ? <Link key={`${index}-${token}`} href={href} className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900">{label}</Link>
        : label);
    } else if (uuidPattern.test(token)) {
      const article = articleMap.get(token);
      nodes.push(article
        ? <Link key={`${index}-${token}`} href={`/articles/${article.id}`} className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900">{articleLabel(article)}</Link>
        : token);
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));

  return <div className={className}>{nodes}</div>;
}

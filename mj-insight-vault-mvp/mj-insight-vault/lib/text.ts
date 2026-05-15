export function normalizeOcrText(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function firstLikelyHeadline(text: string) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.length >= 8 && l.length <= 60) || lines[0] || '無題の記事候補';
}

export function detectFlags(text: string) {
  const hasTable = /表|調査|n=|％|%|前年比|構成比|ランキング|順位/.test(text);
  const hasChart = /グラフ|推移|折れ線|棒グラフ|円グラフ|指数|伸び率/.test(text);
  const hasImage = /写真|画像|イラスト|図/.test(text);
  return { hasTable, hasChart, hasImage };
}

export function buildEmbeddingText(article: { headline?: string | null; ocr_text?: string | null; article_type?: string | null }) {
  return [
    `見出し: ${article.headline || ''}`,
    `記事種別: ${article.article_type || ''}`,
    `本文: ${(article.ocr_text || '').slice(0, 3500)}`
  ].join('\n');
}

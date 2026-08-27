import Link from 'next/link';
import { Database, Upload } from 'lucide-react';

const tiles = [
  { href: '/upload', title: '画像を保存してOCR', body: '新しい画像をストックし、Google OCRを1枚ずつ実行します。', icon: Upload },
  { href: '/ocr-stock', title: 'OCRストック', body: '保存済み画像とOCR本文を確認・コピーし、未処理だけ再実行します。', icon: Database }
];

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div className="card p-6">
        <p className="text-sm font-semibold text-emerald-700">OCR-only 低負荷モード</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">MJ資料を保存して、OCR本文までストックする</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600">
          無料Nano compute向けに処理を縮退しています。現在は画像保管とGoogle OCRだけを使い、記事候補化、Embedding、分類、テーマ分析、レポート生成、538件一括OCRは実行しません。
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Link key={tile.href} href={tile.href} className="card p-5 hover:border-zinc-400">
              <div className="flex items-start gap-4">
                <div className="rounded-2xl bg-emerald-100 p-3"><Icon className="h-5 w-5" /></div>
                <div>
                  <h2 className="font-bold">{tile.title}</h2>
                  <p className="mt-1 text-sm leading-6 text-zinc-600">{tile.body}</p>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

import Link from 'next/link';
import { Cloud, Upload } from 'lucide-react';

const tiles = [
  {
    href: '/upload',
    title: '資料を追加',
    body: '画像やPDFをGoogleドライブへ保存し、MJへ同期します。',
    icon: Upload
  },
  {
    href: '/cloud-stock',
    title: '資料一覧・検索',
    body: '保存済み資料を確認し、画像のOCR実行とOCR本文検索ができます。',
    icon: Cloud
  }
];

export default function HomePage() {
  return (
    <div className="space-y-5">
      <div className="card p-5 sm:p-6">
        <p className="text-sm font-semibold text-emerald-700">原本保管：Googleドライブ ／ データベース：Neon</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">MJ Insight Vault</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600">
          原本はGoogleドライブ、検索・OCR本文・記事インベントリ・レポート用データはNeonで管理します。
          画像OCRは資料一覧から1件ずつ実行できます。分類・テーマ分析・レポート生成・一括処理はまだ自動実行しません。
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
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

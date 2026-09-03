import Link from 'next/link';
import { Cloud, Upload } from 'lucide-react';

const tiles = [
  {
    href: '/upload',
    title: '資料を追加',
    body: '画像やPDFをGoogle Driveへ保存し、Neonへ検索用の情報を登録します。',
    icon: Upload
  },
  {
    href: '/cloud-stock',
    title: '資料一覧・検索',
    body: '保存済み資料を確認し、Neonの登録データを検索します。',
    icon: Cloud
  }
];

export default function HomePage() {
  return (
    <div className="space-y-5">
      <div className="card p-5 sm:p-6">
        <p className="text-sm font-semibold text-emerald-700">Google Drive + Neon</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">MJ Insight Vault</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600">
          原本はGoogle Drive、検索・OCR本文・Inventory・レポート用データはNeonで管理します。
          現在は安全のため、OCR・分類・テーマ分析・レポート生成の自動実行は停止しています。
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

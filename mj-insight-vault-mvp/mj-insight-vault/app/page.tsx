import Link from 'next/link';
import { Upload, MessageSquare, Tags, Newspaper } from 'lucide-react';

const tiles = [
  { href: '/upload', title: '画像アップロード', body: 'MJ画像を投入し、OCRと記事候補化を実行します。', icon: Upload },
  { href: '/articles', title: '記事一覧', body: '蓄積した記事を確認し、不要記事・重複候補を整理します。', icon: Newspaper },
  { href: '/chat', title: 'チャット分析', body: '蓄積記事から生活者変化・業界課題・手法適性を分析します。', icon: MessageSquare },
  { href: '/tags', title: 'タグ管理', body: '業界、生活者圧力、行動変化、手法タグを追加・編集します。', icon: Tags }
];

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div className="card p-6">
        <p className="text-sm font-semibold text-zinc-500">MJ Insight Vault</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">MJ記事をリサーチ仮説DBに変換する</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600">
          キャプチャ画像を保存し、OCRで記事候補化。通常は「記事一覧」で整理し、
          チャットで生活者変化・リサーチ課題・提案書ネタへ変換します。
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <Link key={tile.href} href={tile.href} className="card p-5 hover:border-zinc-400">
              <div className="flex items-start gap-4">
                <div className="rounded-2xl bg-amber-100 p-3"><Icon className="h-5 w-5" /></div>
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

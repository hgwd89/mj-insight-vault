import Link from 'next/link';
import { UploadFormStable } from '@/components/UploadFormStable';

export default function UploadPage() {
  return (
    <div className="space-y-4">
      <UploadFormStable />
      <div className="card p-5">
        <h2 className="font-bold">アップロード履歴</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          失敗画像や重複アップロードを整理したい時だけ確認します。通常は記事一覧を使ってください。
        </p>
        <div className="mt-3 flex gap-2">
          <Link className="btn" href="/batches">アップロード履歴を見る</Link>
          <Link className="btn" href="/articles">記事一覧を見る</Link>
        </div>
      </div>
    </div>
  );
}

import Link from 'next/link';
import { UploadFormOcrOnly } from '@/components/UploadFormOcrOnly';

export default function UploadPage() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
        <b>OCR-only 低負荷モード</b><br />
        現在は画像保管とGoogle OCRだけを実行します。記事候補化、Embedding、分類、テーマ分析、レポート生成、538件一括OCRは停止しています。
      </div>
      <UploadFormOcrOnly />
      <div className="card p-5">
        <h2 className="font-bold">保存済みデータ</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">OCR本文の確認・コピー・未処理画像の1枚ずつ再実行はOCRストック画面から行います。</p>
        <div className="mt-3 flex gap-2">
          <Link className="btn btn-primary" href="/ocr-stock">OCRストックを見る</Link>
          <Link className="btn" href="/batches">旧アップロード履歴</Link>
        </div>
      </div>
    </div>
  );
}

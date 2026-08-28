import Link from 'next/link';
import { UploadFormOcrOnly } from '@/components/UploadFormOcrOnly';

export default function UploadPage() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sky-300 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
        <b>無料ストック優先モード</b><br />
        Supabaseを復旧・課金しなくても、画像/PDFをこのブラウザ内へ無料で保存できます。まずは「無料ローカルストック」を使ってください。
        OCR、記事候補化、Embedding、分類、テーマ分析、レポート生成、538件一括OCRは実行しません。
        <div className="mt-3"><Link className="btn btn-primary" href="/local-stock">無料ローカルストックを開く</Link></div>
      </div>

      <div className="rounded-2xl border border-zinc-300 bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
        <b>従来のSupabase OCR-only経路</b><br />
        下のフォームはSupabase Storage/Data APIが利用可能な場合だけ使えます。現在の一旦のゴールには不要です。
      </div>
      <UploadFormOcrOnly />

      <div className="card p-5">
        <h2 className="font-bold">保存済みデータ</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">無料ローカル保存はブラウザ内、従来OCRストックはSupabase内で別管理です。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="btn btn-primary" href="/local-stock">無料ローカルストック</Link>
          <Link className="btn" href="/ocr-stock">Supabase OCRストック</Link>
          <Link className="btn" href="/batches">旧アップロード履歴</Link>
        </div>
      </div>
    </div>
  );
}

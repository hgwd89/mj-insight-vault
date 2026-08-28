import Link from 'next/link';
import { UploadFormOcrOnly } from '@/components/UploadFormOcrOnly';

const GOOGLE_DRIVE_ORIGINALS = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';

export default function UploadPage() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
        <b>新しい正本ストック：Google Drive + Neon</b><br />
        新しく追加する画像/PDFの原本はGoogle Driveの「MJ Insight Vault / 01 Originals」へ保存します。
        検索・OCR・Inventory・Report用の構造化データは無料PostgresのNeonへ移行中です。Supabaseの復旧・課金は行いません。
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="btn btn-primary" href={GOOGLE_DRIVE_ORIGINALS} target="_blank" rel="noreferrer">Google Driveへ原本を追加</a>
          <Link className="btn" href="/local-stock">非常用ローカル退避</Link>
        </div>
      </div>

      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <b>現在の安全制約</b><br />
        Google Driveへの原本保存は使えます。Neonへの自動メタデータ登録・検索は配線中です。
        それが完了するまでOCR、記事候補化、Embedding、分類、テーマ分析、レポート生成、538件一括OCRは実行しません。
      </div>

      <div className="rounded-2xl border border-zinc-300 bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
        <b>旧Supabase OCR-only経路（凍結）</b><br />
        以下は既存データ互換のため残していますが、新規ストックの正本経路には使用しません。
      </div>
      <UploadFormOcrOnly />

      <div className="card p-5">
        <h2 className="font-bold">保存先</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="btn btn-primary" href={GOOGLE_DRIVE_ORIGINALS} target="_blank" rel="noreferrer">Google Drive原本</a>
          <Link className="btn" href="/local-stock">ブラウザ非常用退避</Link>
          <Link className="btn" href="/ocr-stock">旧Supabase OCRストック</Link>
          <Link className="btn" href="/batches">旧アップロード履歴</Link>
        </div>
      </div>
    </div>
  );
}

import Link from 'next/link';

const GOOGLE_DRIVE_ORIGINALS = 'https://drive.google.com/drive/folders/1C6LBMMZmrP6hdRoOmomz7BMoFXxPZ1QQ';

export default function UploadPage() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5 text-sm leading-6 text-emerald-950">
        <b>現在の正本ストック：Google Drive + Neon</b><br />
        新規資料はGoogle Driveへ原本保存し、Neonへ検索用メタデータを同時登録します。Supabaseは旧データ互換用に凍結し、新規保存では使用しません。
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="btn btn-primary" href="/cloud-stock">クラウドストックを開く</Link>
          <a className="btn" href={GOOGLE_DRIVE_ORIGINALS} target="_blank" rel="noreferrer">01 Originalsを直接開く</a>
        </div>
      </div>

      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <b>現在はストック専用</b><br />
        OCR、記事候補化、Embedding、Classification、Theme Analysis、Report、538件一括OCRはこの経路から起動しません。
        ただしNeon検索は、将来OCR本文が登録された時点で同じ検索画面から本文まで検索できる構造です。
      </div>

      <div className="card p-5">
        <h2 className="font-bold">保存先の役割</h2>
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 p-3"><b>Google Drive</b><br />画像/PDF原本の正本</div>
          <div className="rounded-xl border border-zinc-200 p-3"><b>Neon</b><br />検索・OCR本文・Inventory・Report用DB</div>
          <div className="rounded-xl border border-zinc-200 p-3"><b>IndexedDB</b><br />非常時の一時退避のみ</div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className="btn" href="/local-stock">非常用ローカル退避</Link>
          <Link className="btn" href="/ocr-stock">旧Supabase OCRストック</Link>
          <Link className="btn" href="/batches">旧Supabase履歴</Link>
        </div>
      </div>
    </div>
  );
}

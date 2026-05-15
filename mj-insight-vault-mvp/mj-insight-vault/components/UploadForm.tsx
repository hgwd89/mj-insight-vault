'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppPassword } from '@/components/PasswordGate';

export function UploadForm() {
  const password = useAppPassword();
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const heicFiles = useMemo(() => files.filter((f) => /heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name)), [files]);

  async function upload() {
    setBusy(true);
    setStatus('アップロード・OCR処理中です。20枚近い場合は時間がかかります。');
    try {
      const form = new FormData();
      form.set('memo', memo);
      files.forEach((file) => form.append('files', file));
      const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-app-password': password }, body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      setStatus(`完了：記事候補 ${json.articles?.length || 0} 件を作成しました。`);
      router.push(`/batches/${json.batch.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'エラーが発生しました。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <h1 className="text-xl font-black">MJ画像アップロード</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-600">最大20枚。アップロード後、常にOCRと記事候補化を実行します。</p>
      <div className="mt-5 space-y-4">
        <textarea className="input min-h-20" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ：2026年5月前半 / 食品・化粧品多め など" />
        <input
          className="input"
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, 20))}
        />
        {heicFiles.length > 0 && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-6">
            HEIC/HEIFが含まれています。環境によってはOCR前処理で失敗します。iPhoneは「設定 &gt; カメラ &gt; フォーマット &gt; 互換性優先」にするとJPG保存になります。
          </div>
        )}
        <div className="text-sm text-zinc-600">選択中：{files.length}枚</div>
        {files.length > 0 && (
          <ul className="max-h-48 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
            {files.map((file) => <li key={file.name}>{file.name} / {(file.size / 1024 / 1024).toFixed(1)}MB</li>)}
          </ul>
        )}
        <button className="btn btn-primary" onClick={upload} disabled={!files.length || busy}>アップロードしてOCR</button>
        {status && <p className="text-sm leading-6 text-zinc-700">{status}</p>}
      </div>
    </div>
  );
}

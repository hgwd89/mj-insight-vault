'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppPassword } from '@/components/PasswordGate';

const MAX_FILES = 20;
const MAX_FILE_MB = 4;

export function UploadForm() {
  const password = useAppPassword();
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [memo, setMemo] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const heicFiles = useMemo(() => files.filter((f) => /heic|heif/i.test(f.type) || /\.hei[cf]$/i.test(f.name)), [files]);
  const oversizedFiles = useMemo(() => files.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024), [files]);

  function selectFiles(nextFiles: File[]) {
    if (nextFiles.length > MAX_FILES) {
      setStatus(`最大${MAX_FILES}枚までです。${MAX_FILES}枚に絞りました。不要な画像を削除して再実行してください。`);
    } else {
      setStatus('');
    }

    setFiles(nextFiles.slice(0, MAX_FILES));
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function clearFiles() {
    setFiles([]);
    setStatus('選択画像をクリアしました。');
  }

  async function upload() {
    if (files.length > MAX_FILES) {
      setStatus(`最大${MAX_FILES}枚までに減らしてください。`);
      return;
    }

    if (oversizedFiles.length > 0) {
      setStatus(`${MAX_FILE_MB}MBを超える画像があります。VercelのFunction本文サイズ制限にかかりやすいため、画像を減らすか圧縮してください。`);
      return;
    }

    setBusy(true);
    setStatus('アップロード・OCR処理中です。枚数が多い場合は時間がかかります。');

    try {
      const form = new FormData();
      form.set('memo', memo);
      files.forEach((file) => form.append('files', file));

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-app-password': password },
        body: form
      });

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
      <p className="mt-2 text-sm leading-6 text-zinc-600">
        最大{MAX_FILES}枚。画像は1枚あたり{MAX_FILE_MB}MB以下推奨です。多すぎる場合はこの画面で削除してから再実行できます。
      </p>

      <div className="mt-5 space-y-4">
        <textarea
          className="input min-h-20"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="メモ：2026年5月前半 / 食品・化粧品多め など"
        />

        <input
          className="input"
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          onChange={(e) => selectFiles(Array.from(e.target.files || []))}
          disabled={busy}
        />

        {heicFiles.length > 0 && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm leading-6">
            HEIC/HEIFが含まれています。環境によってはOCR前処理で失敗します。iPhoneは「設定 &gt; カメラ &gt; フォーマット &gt; 互換性優先」にするとJPG保存になります。
          </div>
        )}

        {oversizedFiles.length > 0 && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-700">
            {MAX_FILE_MB}MBを超える画像が{oversizedFiles.length}枚あります。アップロード失敗の原因になりやすいため、削除または圧縮してください。
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-600">
          <span>選択中：{files.length}/{MAX_FILES}枚</span>
          {files.length > 0 && <button className="btn" type="button" onClick={clearFiles} disabled={busy}>全てクリア</button>}
        </div>

        {files.length > 0 && (
          <ul className="max-h-64 overflow-auto rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm">
            {files.map((file, index) => {
              const sizeMb = file.size / 1024 / 1024;
              const tooLarge = sizeMb > MAX_FILE_MB;

              return (
                <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 border-b border-zinc-200 py-2 last:border-b-0">
                  <span className={tooLarge ? 'text-red-600' : ''}>{index + 1}. {file.name} / {sizeMb.toFixed(1)}MB</span>
                  <button className="btn shrink-0" type="button" onClick={() => removeFile(index)} disabled={busy}>削除</button>
                </li>
              );
            })}
          </ul>
        )}

        <button className="btn btn-primary" onClick={upload} disabled={!files.length || busy || oversizedFiles.length > 0}>
          {busy ? '処理中' : 'アップロードしてOCR'}
        </button>

        {status && <p className="text-sm leading-6 text-zinc-700">{status}</p>}
      </div>
    </div>
  );
}

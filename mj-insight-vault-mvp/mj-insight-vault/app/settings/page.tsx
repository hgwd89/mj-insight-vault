'use client';

import { useEffect, useState } from 'react';
import { useAppPassword, useClearAppPassword } from '@/components/PasswordGate';

type DiagnosticCheck = {
  name: string;
  ok: boolean;
  detail?: string;
  message?: string;
};

type DiagnosticResponse = {
  ok: boolean;
  checks: DiagnosticCheck[];
};

export default function SettingsPage() {
  const password = useAppPassword();
  const clearPassword = useClearAppPassword();
  const [diagnostics, setDiagnostics] = useState<DiagnosticResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadDiagnostics() {
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/diagnostics', {
        headers: { 'x-app-password': password }
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '診断に失敗しました');
      setDiagnostics(json);
    } catch (error) {
      setError(error instanceof Error ? error.message : '診断に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDiagnostics();
  }, []);

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h1 className="text-xl font-black">設定</h1>
        <p className="mt-3 text-sm leading-7 text-zinc-600">
          この画面では端末に保存したパスコードと、Vercel環境変数・Supabase・Storageの接続状態を確認できます。
        </p>

        <div className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm">
          保存中のパスコード：{password ? '設定済み' : '未設定'}
        </div>

        <button className="btn mt-4" onClick={clearPassword}>
          この端末のパスコードを消去
        </button>
      </div>

      <section className="card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-bold">接続診断</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">
              OCR・分析・保存に必要な環境変数と接続を確認します。
            </p>
          </div>

          <button className="btn" onClick={loadDiagnostics} disabled={loading}>
            {loading ? '診断中' : '再診断'}
          </button>
        </div>

        {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-600">{error}</p>}

        {diagnostics && (
          <div className="mt-4 space-y-2">
            <div className={diagnostics.ok ? 'rounded-xl bg-green-50 p-3 text-sm text-green-700' : 'rounded-xl bg-amber-50 p-3 text-sm text-amber-700'}>
              総合状態：{diagnostics.ok ? 'OK' : '要確認'}
            </div>

            <div className="grid gap-2">
              {diagnostics.checks.map((check) => (
                <div key={check.name} className="rounded-xl border border-zinc-200 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <b>{check.name}</b>
                    <span className={check.ok ? 'badge bg-green-50 text-green-700' : 'badge bg-red-50 text-red-700'}>
                      {check.ok ? 'OK' : 'NG'}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-zinc-600">{check.detail || check.message || ''}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

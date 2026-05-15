'use client';

import { useAppPassword } from '@/components/PasswordGate';

export default function SettingsPage() {
  const { clear } = { clear: () => { localStorage.removeItem('mj_app_password'); location.reload(); } };
  const password = useAppPassword();
  return (
    <div className="card p-5">
      <h1 className="text-xl font-black">設定</h1>
      <p className="mt-3 text-sm leading-7 text-zinc-600">この画面ではブラウザに保存した固定パスコードだけを管理します。APIキー類はVercelの環境変数に設定します。</p>
      <div className="mt-4 rounded-xl bg-zinc-50 p-4 text-sm">保存中のパスコード：{password ? '設定済み' : '未設定'}</div>
      <button className="btn mt-4" onClick={clear}>この端末のパスコードを消去</button>
    </div>
  );
}

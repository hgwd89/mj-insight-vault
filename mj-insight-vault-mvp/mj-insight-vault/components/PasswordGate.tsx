'use client';

import { createContext, useContext, useEffect, useState } from 'react';

const PasswordContext = createContext<{ password: string; clear: () => void }>({ password: '', clear: () => {} });

export function useAppPassword() {
  return useContext(PasswordContext).password;
}

export function PasswordGate({ children }: { children: React.ReactNode }) {
  const [password, setPassword] = useState('');
  const [input, setInput] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPassword(localStorage.getItem('mj_app_password') || '');
    setReady(true);
  }, []);

  if (!ready) return null;

  const clear = () => {
    localStorage.removeItem('mj_app_password');
    setPassword('');
  };

  if (!password) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 p-4">
        <div className="card w-full max-w-md p-6">
          <p className="text-sm font-semibold text-zinc-500">MJ Insight Vault</p>
          <h1 className="mt-2 text-xl font-black">アクセス用パスコード</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-600">ログイン機能は使わず、固定パスコードで個人用アプリを保護します。</p>
          <form
            className="mt-5 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              localStorage.setItem('mj_app_password', input);
              setPassword(input);
            }}
          >
            <input className="input" type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="APP_PASSWORD" />
            <button className="btn btn-primary w-full" type="submit" disabled={!input}>入る</button>
          </form>
        </div>
      </main>
    );
  }

  return <PasswordContext.Provider value={{ password, clear }}>{children}</PasswordContext.Provider>;
}

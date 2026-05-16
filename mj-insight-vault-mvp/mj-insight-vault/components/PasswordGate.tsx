'use client';

import { createContext, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'mj_app_password';

type PasswordContextValue = {
  password: string;
  clear: () => void;
};

const PasswordContext = createContext<PasswordContextValue>({
  password: '',
  clear: () => {}
});

export function useAppPassword() {
  return useContext(PasswordContext).password;
}

export function useClearAppPassword() {
  return useContext(PasswordContext).clear;
}

async function checkPassword(candidate: string) {
  const res = await fetch('/api/batches', {
    method: 'GET',
    headers: {
      'x-app-password': candidate
    }
  });

  if (res.status === 401) {
    return {
      ok: false,
      message: 'パスコードが違います。もう一度入力してください。'
    };
  }

  if (!res.ok) {
    return {
      ok: true,
      message: 'パスコードは保存しました。ただしDB/API側で別エラーが出ています。'
    };
  }

  return {
    ok: true,
    message: ''
  };
}

export function PasswordGate({ children }: { children: React.ReactNode }) {
  const [password, setPassword] = useState('');
  const [input, setInput] = useState('');
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) || '';

    if (!saved) {
      setReady(true);
      return;
    }

    setChecking(true);
    checkPassword(saved)
      .then((result) => {
        if (result.ok) {
          setPassword(saved);
          setMessage(result.message);
        } else {
          localStorage.removeItem(STORAGE_KEY);
          setPassword('');
          setInput('');
          setMessage(result.message);
        }
      })
      .catch(() => {
        setPassword(saved);
        setMessage('保存済みパスコードで開始します。通信エラーの場合は各画面で再確認してください。');
      })
      .finally(() => {
        setChecking(false);
        setReady(true);
      });
  }, []);

  const clear = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPassword('');
    setInput('');
    setMessage('パスコードをリセットしました。入力し直してください。');
  };

  async function submitPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const candidate = input.trim();
    if (!candidate) return;

    setChecking(true);
    setMessage('確認中です。');

    try {
      const result = await checkPassword(candidate);

      if (!result.ok) {
        localStorage.removeItem(STORAGE_KEY);
        setPassword('');
        setInput('');
        setMessage(result.message);
        return;
      }

      localStorage.setItem(STORAGE_KEY, candidate);
      setPassword(candidate);
      setMessage(result.message || 'パスコードを保存しました。');
    } catch {
      setMessage('通信エラーで確認できませんでした。ネットワークまたはVercelの状態を確認してください。');
    } finally {
      setChecking(false);
    }
  }

  if (!ready) return null;

  if (!password) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 p-4">
        <div className="card w-full max-w-md p-6">
          <p className="text-sm font-semibold text-zinc-500">MJ Insight Vault</p>
          <h1 className="mt-2 text-xl font-black">アクセス用パスコード</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-600">
            Vercel環境変数 APP_PASSWORD に設定した文字列を入力してください。間違えた場合は保存せず、この画面で再入力できます。
          </p>

          {message && (
            <p className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 text-zinc-700">
              {message}
            </p>
          )}

          <form className="mt-5 space-y-3" onSubmit={submitPassword}>
            <input
              className="input"
              type="password"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (message) setMessage('');
              }}
              placeholder="APP_PASSWORD"
              autoComplete="current-password"
              autoFocus
            />

            <button className="btn btn-primary w-full" type="submit" disabled={!input.trim() || checking}>
              {checking ? '確認中' : '入る'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <PasswordContext.Provider value={{ password, clear }}>
      {children}
    </PasswordContext.Provider>
  );
}

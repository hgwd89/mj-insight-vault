'use client';

import { useEffect, useState } from 'react';
import { useAppPassword, useClearAppPassword } from '@/components/PasswordGate';

type ApiErrorBody = {
  error?: unknown;
};

export function useApi<T>(url: string) {
  const password = useAppPassword();
  const clearPassword = useClearAppPassword();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError('');

    fetch(url, { headers: { 'x-app-password': password } })
      .then(async (r) => {
        let json: unknown = null;

        try {
          json = await r.json();
        } catch {
          json = null;
        }

        if (r.status === 401) {
          clearPassword();
          throw new Error('パスコードが違います。入力し直してください。');
        }

        if (!r.ok) {
          const body = json && typeof json === 'object' ? json as ApiErrorBody : {};
          throw new Error(typeof body.error === 'string' ? body.error : 'API error');
        }

        if (!ignore) setData(json as T);
      })
      .catch((e) => {
        if (!ignore) setError(e instanceof Error ? e.message : 'API error');
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [url, password, clearPassword]);

  return { data, error, loading };
}

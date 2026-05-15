'use client';

import { useEffect, useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

export function useApi<T>(url: string) {
  const password = useAppPassword();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    fetch(url, { headers: { 'x-app-password': password } })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || 'API error');
        if (!ignore) setData(json);
      })
      .catch((e) => !ignore && setError(e.message))
      .finally(() => !ignore && setLoading(false));
    return () => { ignore = true; };
  }, [url, password]);
  return { data, error, loading };
}

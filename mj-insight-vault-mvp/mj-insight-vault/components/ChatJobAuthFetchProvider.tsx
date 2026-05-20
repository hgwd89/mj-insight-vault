'use client';

import { useLayoutEffect } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

function needsChatJobPassword(url: string) {
  try {
    const parsed = url.startsWith('http') ? new URL(url) : new URL(url, window.location.origin);
    return parsed.pathname === '/api/chat/jobs' || parsed.pathname.startsWith('/api/chat/jobs/');
  } catch {
    return url === '/api/chat/jobs' || url.startsWith('/api/chat/jobs/');
  }
}

function withPasswordHeader(init: RequestInit | undefined, password: string): RequestInit {
  const headers = new Headers(init?.headers || {});
  if (password && !headers.has('x-app-password')) headers.set('x-app-password', password);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return { ...init, headers };
}

export function ChatJobAuthFetchProvider({ children }: { children: React.ReactNode }) {
  const password = useAppPassword();

  useLayoutEffect(() => {
    if (!password) return;
    const originalFetch = window.fetch;

    window.fetch = async (...args) => {
      const target = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
      if (!needsChatJobPassword(target)) return originalFetch(...args);
      return originalFetch(args[0], withPasswordHeader(args[1], password));
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [password]);

  return <>{children}</>;
}

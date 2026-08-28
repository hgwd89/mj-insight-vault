'use client';

import { useEffect, useRef } from 'react';
import { useAppPassword } from '@/components/PasswordGate';
import { CloudStockVault } from '@/components/CloudStockVault';

export function CloudStockAutoBootstrap() {
  const appPassword = useAppPassword();
  const attempted = useRef(false);

  useEffect(() => {
    if (!appPassword || attempted.current) return;
    attempted.current = true;

    void (async () => {
      const current = await fetch('/api/cloud-stock/auth', {
        headers: { 'x-app-password': appPassword }
      }).catch(() => null);
      if (current?.ok) return;

      const auto = await fetch('/api/cloud-stock/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': appPassword },
        body: JSON.stringify({ action: 'auto' })
      }).catch(() => null);

      if (auto?.ok) window.location.reload();
    })();
  }, [appPassword]);

  return <CloudStockVault />;
}

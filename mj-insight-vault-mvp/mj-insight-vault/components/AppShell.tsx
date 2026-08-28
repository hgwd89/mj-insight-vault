'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { ArchiveRestore, Cloud, Database, Home, Upload } from 'lucide-react';
import { useClearAppPassword } from '@/components/PasswordGate';

const nav = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/upload', label: 'Upload', icon: Upload },
  { href: '/cloud-stock', label: 'Cloud Stock', icon: Cloud },
  { href: '/legacy-import', label: 'Legacy', icon: ArchiveRestore },
  { href: '/ocr-stock', label: 'OCR Stock', icon: Database }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const clearPassword = useClearAppPassword();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/" className="font-black tracking-tight">MJ Insight Vault</Link>
          <div className="flex items-center gap-2">
            <nav className="flex gap-1">
              {nav.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                return (
                  <Link key={item.href} href={item.href} className={clsx('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold', active ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}>
                    <Icon className="h-4 w-4" /> <span className="hidden sm:inline">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
            <button className="rounded-xl border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-600 hover:bg-zinc-100" type="button" onClick={clearPassword}>
              パスコード変更
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

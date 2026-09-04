'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { FileText, Newspaper, Home, Upload } from 'lucide-react';
import { useClearAppPassword } from '@/components/PasswordGate';

const nav = [
  { href: '/', label: 'ホーム', icon: Home },
  { href: '/upload', label: '資料追加', icon: Upload },
  { href: '/cloud-stock', label: '記事一覧・検索', icon: Newspaper },
  { href: '/chat', label: 'レポート生成', icon: FileText }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const clearPassword = useClearAppPassword();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-3 py-2 sm:px-4">
          <div className="flex items-center justify-between gap-3">
            <Link href="/" className="min-w-0 truncate text-sm font-black tracking-tight sm:text-base">MJ Insight Vault</Link>
            <button className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 sm:px-3 sm:py-2 sm:text-sm" type="button" onClick={clearPassword}>
              パスコード変更
            </button>
          </div>
          <nav className="mt-2 grid grid-cols-4 gap-1">
            {nav.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
              return (
                <Link key={item.href} href={item.href} className={clsx('flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[11px] font-semibold sm:flex-row sm:gap-2 sm:px-3 sm:text-sm', active ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}>
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">{children}</main>
    </div>
  );
}

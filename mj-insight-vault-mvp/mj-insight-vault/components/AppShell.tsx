'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { BarChart3, ClipboardList, Database, MessageSquare, Newspaper, Settings, Tags, Upload } from 'lucide-react';
import { useClearAppPassword } from '@/components/PasswordGate';

const nav = [
  { href: '/', label: 'Home', icon: BarChart3 },
  { href: '/upload', label: 'Upload', icon: Upload },
  { href: '/batches', label: 'Batches', icon: Database },
  { href: '/articles', label: 'Articles', icon: Newspaper },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/reports', label: 'Reports', icon: ClipboardList },
  { href: '/tags', label: 'Tags', icon: Tags },
  { href: '/settings', label: 'Settings', icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const clearPassword = useClearAppPassword();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/" className="font-black tracking-tight">MJ Insight Vault</Link>

          <div className="hidden items-center gap-2 md:flex">
            <nav className="flex gap-1">
              {nav.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                return (
                  <Link key={item.href} href={item.href} className={clsx('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold', active ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100')}>
                    <Icon className="h-4 w-4" /> {item.label}
                  </Link>
                );
              })}
            </nav>

            <button
              className="rounded-xl border border-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-600 hover:bg-zinc-100"
              type="button"
              onClick={clearPassword}
            >
              パスコード変更
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-zinc-200 bg-white md:hidden">
        <div className="grid grid-cols-5">
          {nav.slice(1, 6).map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={clsx('flex flex-col items-center gap-1 py-2 text-[11px]', active ? 'text-zinc-950' : 'text-zinc-500')}>
                <Icon className="h-5 w-5" />{item.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <button
        className="fixed bottom-16 right-3 z-30 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-600 shadow md:hidden"
        type="button"
        onClick={clearPassword}
      >
        パスコード変更
      </button>

      <div className="h-14 md:hidden" />
    </div>
  );
}

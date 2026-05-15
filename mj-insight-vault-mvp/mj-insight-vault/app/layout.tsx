import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/AppShell';
import { PasswordGate } from '@/components/PasswordGate';

export const metadata: Metadata = {
  title: 'MJ Insight Vault',
  description: 'MJ記事キャプチャをOCR・蓄積・分析する個人用PWA',
  manifest: '/manifest.webmanifest'
};

export const viewport: Viewport = {
  themeColor: '#111111',
  width: 'device-width',
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <PasswordGate>
          <AppShell>{children}</AppShell>
        </PasswordGate>
      </body>
    </html>
  );
}

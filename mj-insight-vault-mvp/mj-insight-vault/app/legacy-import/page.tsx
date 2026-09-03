import Link from 'next/link';

export default function LegacyImportPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">Retired</p>
        <h1 className="mt-2 text-2xl font-black tracking-tight">Supabase連携は退役しました</h1>
        <p className="mt-3 text-sm leading-7 text-zinc-600">
          MJ Insight Vaultの正系ストレージはGoogle Drive + Neonです。SupabaseからのStorage/DB import経路は無効化され、再実行されません。
        </p>
        <Link href="/cloud-stock" className="mt-5 inline-flex rounded-xl bg-zinc-900 px-4 py-2 text-sm font-bold text-white">
          資料一覧・検索へ
        </Link>
      </div>
    </div>
  );
}

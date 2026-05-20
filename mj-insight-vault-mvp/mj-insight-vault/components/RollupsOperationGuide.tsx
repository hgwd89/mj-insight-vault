import Link from 'next/link';

export function RollupsOperationGuide({
  monthCount,
  readyCount,
  staleCount,
  failedCount,
  missingCount,
  totalArticles
}: {
  monthCount: number;
  readyCount: number;
  staleCount: number;
  failedCount: number;
  missingCount: number;
  totalArticles: number;
}) {
  const complete = monthCount > 0 && readyCount === monthCount && staleCount === 0 && failedCount === 0;
  const judgment = complete
    ? '全月の月別まとめが使用可能です。Chatで全体分析できます。'
    : readyCount > 0
      ? '使用可能な月別まとめはありますが、未作成・要更新・失敗の月が残っています。'
      : 'まだ使用可能な月別まとめがありません。まず全月まとめ生成を実行してください。';

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <h2 className="text-xl font-black">月別まとめの使い方</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">
          記事は残したまま、月ごとに主要テーマ・生活者ナラティブ・弱い兆し・調査論点・根拠記事IDを保存します。全体分析では、この月別まとめを優先して横断します。
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-xs font-bold text-zinc-500">初回</p>
            <h3 className="mt-1 font-black">全月まとめ生成</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">最初は全月を作成します。月が多い場合は時間がかかります。</p>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-xs font-bold text-zinc-500">記事追加後</p>
            <h3 className="mt-1 font-black">要更新の月だけ再生成</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">新しい記事が入った月だけ作り直します。毎回全月を作り直す必要はありません。</p>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-xs font-bold text-zinc-500">分析時</p>
            <h3 className="mt-1 font-black">Chatで全体分析</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">使用可能な月別まとめがあれば、Chatの全体分析で優先参照されます。</p>
            <Link className="btn mt-3 inline-flex" href="/chat">Chatへ</Link>
          </div>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="font-black">現在の判断</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-600">{judgment}</p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="badge">記事あり月 {monthCount}</span>
          <span className="badge">使用可 {readyCount}</span>
          <span className="badge">未作成 {missingCount}</span>
          <span className="badge">要更新 {staleCount}</span>
          <span className="badge">失敗 {failedCount}</span>
          <span className="badge">対象記事 {totalArticles}</span>
        </div>
      </section>
    </div>
  );
}

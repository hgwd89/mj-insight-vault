'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

type R=Record<string,unknown>;
function rec(v:unknown):v is R{return Boolean(v&&typeof v==='object'&&!Array.isArray(v))}
function text(v:unknown){return v===undefined||v===null?'':String(v).trim()}

export function ReportTestPanel(){
  const password=useAppPassword();
  const router=useRouter();
  const [query,setQuery]=useState('');
  const [model,setModel]=useState('gpt-4o-mini');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function submit(){
    const q=query.trim();
    if(!q||busy)return;
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/report-test',{method:'POST',headers:{'content-type':'application/json','x-app-password':password},body:JSON.stringify({query:q,model})});
      const json=await response.json().catch(()=>({}));
      const report=rec(json)&&rec(json.report)?json.report:{};
      const id=text(report.id);
      if(!response.ok)throw new Error(text(rec(json)?json.error:'')||'暫定レポート生成に失敗しました');
      if(!id)throw new Error('保存済みレポートIDを取得できませんでした');
      router.push(`/reports/${encodeURIComponent(id)}`);
    }catch(e){setError(e instanceof Error?e.message:'暫定レポート生成に失敗しました');setBusy(false)}
  }

  return <div className="space-y-4">
    <div className="card border-amber-300 bg-amber-50 p-5">
      <h1 className="text-xl font-black text-amber-950">Preview：レポート化テスト</h1>
      <p className="mt-2 text-sm leading-6 text-amber-900">正式全件ゲートを待たず、現在の検索・根拠抽出・Writer・保存・閲覧までを人が通しで確認するための暫定テストです。生成物は正式レポートではなく「暫定・未検証」として保存されます。</p>
    </div>
    <div className="card p-5">
      <label className="block"><span className="text-sm font-bold text-zinc-700">分析指示</span><textarea className="input mt-2 min-h-40" value={query} onChange={e=>setQuery(e.target.value)} placeholder="例：生活者が物価上昇下で何を維持し、何を削っているか。記事根拠と反証を分けて整理してください。" disabled={busy}/></label>
      <label className="mt-4 block"><span className="text-sm font-bold text-zinc-700">テスト用モデル</span><select className="input mt-2" value={model} onChange={e=>setModel(e.target.value)} disabled={busy}><option value="gpt-4o-mini">gpt-4o-mini｜低コスト</option><option value="gpt-4.1">gpt-4.1｜安定</option><option value="gpt-5-mini">gpt-5-mini｜標準</option></select></label>
      {error&&<div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      <div className="mt-5 flex flex-wrap items-center gap-3"><button className="btn btn-primary" type="button" onClick={submit} disabled={busy||!query.trim()}>{busy?'暫定レポート生成中':'暫定レポート生成を開始'}</button><span className="text-xs text-zinc-500">生成・保存が完了すると、そのレポート詳細画面へ直接移動します。</span></div>
    </div>
  </div>;
}

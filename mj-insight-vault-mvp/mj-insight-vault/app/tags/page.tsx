'use client';

import { useState } from 'react';
import { useApi } from '@/components/DataHooks';
import { useAppPassword } from '@/components/PasswordGate';

type Tag = { id: string; tag_type: string; tag_name: string; description: string | null };
const tagTypes = ['industry', 'consumer_pressure', 'behavior_change', 'method_fit', 'custom_theme'];

export default function TagsPage() {
  const password = useAppPassword();
  const { data, error, loading } = useApi<{ tags: Tag[] }>('/api/tags');
  const [tagType, setTagType] = useState('industry');
  const [tagName, setTagName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');

  async function addTag() {
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-password': password },
      body: JSON.stringify({ tag_type: tagType, tag_name: tagName, description })
    });
    const json = await res.json();
    if (!res.ok) setMessage(json.error || '追加に失敗しました');
    else {
      setMessage('追加しました。ページを再読み込みすると反映されます。');
      setTagName('');
      setDescription('');
    }
  }

  const grouped = (data?.tags || []).reduce<Record<string, Tag[]>>((acc, tag) => {
    acc[tag.tag_type] ||= [];
    acc[tag.tag_type].push(tag);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h1 className="text-xl font-black">タグ管理</h1>
        <p className="mt-2 text-sm text-zinc-600">新しい業界・圧力・行動変化・テーマが出たら追加します。</p>
        <div className="mt-4 grid gap-3 md:grid-cols-[180px_1fr_1fr_auto]">
          <select className="input" value={tagType} onChange={(e) => setTagType(e.target.value)}>{tagTypes.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <input className="input" value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="タグ名" />
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="説明 任意" />
          <button className="btn btn-primary" onClick={addTag} disabled={!tagName}>追加</button>
        </div>
        {message && <p className="mt-3 text-sm text-zinc-700">{message}</p>}
      </div>
      {loading && <div className="card p-5">読み込み中</div>}
      {error && <div className="card p-5 text-red-600">{error}</div>}
      {Object.entries(grouped).map(([type, tags]) => (
        <section key={type} className="card p-5">
          <h2 className="font-bold">{type}</h2>
          <div className="mt-3 flex flex-wrap gap-2">{tags.map((tag) => <span key={tag.id} className="badge">{tag.tag_name}</span>)}</div>
        </section>
      ))}
    </div>
  );
}

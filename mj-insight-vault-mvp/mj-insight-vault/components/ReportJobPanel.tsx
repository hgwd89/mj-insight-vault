'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const CHAT_RUN_STORAGE_KEY = 'mj-chat-active-run-v3';
const CHAT_RUN_EVENT = 'mj-chat-run-state';
const PIPELINE_VERSION = 'neon_report_pipeline_v2_durable';

const models = [
  { value: 'gpt-5', label: 'gpt-5｜AAAA詳細分析・推奨' },
  { value: 'gpt-5-mini', label: 'gpt-5-mini｜標準' },
  { value: 'gpt-4.1', label: 'gpt-4.1｜安定' },
  { value: 'gpt-4o-mini', label: 'gpt-4o-mini｜低コスト' }
] as const;

const outputTemplates = [
  { value: 'auto', label: '自動' },
  { value: 'trend', label: '生活者トレンド' },
  { value: 'why', label: 'WHY深掘り' },
  { value: 'research', label: 'リサーチ課題化' },
  { value: 'proposal', label: '提案書ネタ' }
] as const;

const REPORT_REQUIREMENTS = `目的は、MJ記事群から生活者インサイトとリサーチ課題を発見することです。
AAAAレベルの詳細分析として、answer_textを必須とし、エグゼクティブサマリー、分析対象・読み方、主要な観察事実、生活者動向のナラティブ、緊張・矛盾・トレードオフ、WHY3段階の説明仮説、競合する複数仮説の比較、セグメント・状況差、弱い兆候、マーケティング・事業への示唆、追加調査で検証すべき論点、根拠マトリクス、反証・別解釈、限界・言えないこと、品質評価を含めてください。
重要主張には根拠記事IDと記事リンクを付け、事実・横断観察・解釈・仮説・未検証を分離してください。記事にないことを断定せず、弱い推論は調査が必要と明記してください。`;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function jobRunState(job: JsonRecord, fallback: { query: string; model: string; output_template: string }) {
  const request = isRecord(job.request_json) ? job.request_json : {};
  const createdAt = text(job.created_at);
  const createdMs = createdAt ? Date.parse(createdAt) : Date.now();
  return {
    status: text(job.status) === 'running' ? 'running' : 'queued',
    query: text(job.user_query || request.query) || fallback.query,
    model: text(request.model) || fallback.model,
    target_scope: 'all',
    output_template: text(request.output_template) || fallback.output_template,
    started_at: Number.isNaN(createdMs) ? Date.now() : createdMs,
    updated_at: Date.now(),
    progress: Number(job.progress || 5),
    stage: text(job.stage) || 'Durable Workflowを開始しました',
    job_id: text(job.id),
    next_retry_at: text(job.next_retry_at) || undefined
  };
}

function saveRun(run: ReturnType<typeof jobRunState>) {
  window.localStorage.setItem(CHAT_RUN_STORAGE_KEY, JSON.stringify(run));
  window.dispatchEvent(new CustomEvent(CHAT_RUN_EVENT, { detail: run }));
}

export function ReportJobPanel() {
  const password = useAppPassword();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('gpt-5');
  const [outputTemplate, setOutputTemplate] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');

    try {
      const response = await fetch('/api/chat/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          query: trimmed,
          model,
          target_scope: 'all',
          output_template: outputTemplate,
          report_requirements: REPORT_REQUIREMENTS,
          require_full_corpus: true,
          pipeline_version: PIPELINE_VERSION
        })
      });
      const json = await response.json().catch(() => ({}));
      const job = isRecord(json) && isRecord(json.job) ? json.job : {};
      const jobId = text(job.id);

      if (response.status === 409 && jobId) {
        saveRun(jobRunState(job, { query: trimmed, model, output_template: outputTemplate }));
        router.push('/reports');
        return;
      }
      if (!response.ok || !jobId) {
        throw new Error(text(isRecord(json) ? json.error : '') || response.statusText || 'ジョブ作成に失敗しました');
      }

      saveRun(jobRunState(job, { query: trimmed, model, output_template: outputTemplate }));
      router.push('/reports');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ジョブ作成に失敗しました');
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div>
        <h1 className="text-xl font-black">レポート生成｜AAAA詳細分析</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Neonに保存されたOCR済み記事を全件読み、観察事実から生活者ナラティブ、WHY、競合仮説、示唆、反証・限界まで統合します。処理はDurable Workflowで継続するため、開始後はアプリを閉じても構いません。
        </p>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="block md:col-span-2">
          <span className="text-sm font-bold text-zinc-700">分析指示</span>
          <textarea
            className="input mt-2 min-h-36"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例：化粧品のトレンドを、生活者の行動・感情・価値観の変化まで含めて分析"
            disabled={busy}
          />
        </label>

        <div className="block">
          <span className="text-sm font-bold text-zinc-700">分析対象</span>
          <div className="input mt-2 flex items-center">全記事（Neon canonical）</div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">カテゴリ分類はcanonicalデータに未搭載のため、テーマは分析指示で指定します。存在しないカテゴリ分類で絞ったふりはしません。</p>
        </div>

        <label className="block">
          <span className="text-sm font-bold text-zinc-700">最終レポートモデル</span>
          <select className="input mt-2" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
            {models.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <p className="mt-1 text-xs leading-5 text-zinc-500">本文読解は gpt-5-mini、最終統合はここで選んだモデルを使用します。AAAA詳細分析のデフォルトは gpt-5 です。</p>
        </label>

        <label className="block md:col-span-2">
          <span className="text-sm font-bold text-zinc-700">出力形式</span>
          <select className="input mt-2" value={outputTemplate} onChange={(event) => setOutputTemplate(event.target.value)} disabled={busy}>
            {outputTemplates.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" type="button" onClick={submit} disabled={busy || !query.trim()}>
          {busy ? 'ジョブを開始中' : 'AAAA詳細レポート生成を開始'}
        </button>
        <p className="text-xs leading-5 text-zinc-500">ジョブ状態はNeonに保存されます。ページやアプリを閉じてもサーバー側で処理が続き、再度開けば進捗を復元します。</p>
      </div>
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAppPassword } from '@/components/PasswordGate';

const CHAT_RUN_STORAGE_KEY = 'mj-chat-active-run-v3';
const CHAT_RUN_EVENT = 'mj-chat-run-state';
const PIPELINE_VERSION = 'report_pipeline_v3';

const models = [
  { value: 'gpt-5-mini', label: 'gpt-5-mini｜標準' },
  { value: 'gpt-5', label: 'gpt-5｜高品質・高コスト' },
  { value: 'gpt-4.1', label: 'gpt-4.1｜安定' },
  { value: 'gpt-4o-mini', label: 'gpt-4o-mini｜低コスト' }
] as const;

const categories = [
  { value: 'beauty_cosmetics', label: '化粧品・美容' },
  { value: 'food_beverage', label: '食品・飲料' },
  { value: 'retail_channel', label: '小売・流通・店頭' },
  { value: 'health_wellness', label: '健康・ウェルネス' },
  { value: 'digital_ai', label: 'デジタル・AI・アプリ' },
  { value: 'fashion_apparel', label: 'ファッション・アパレル' },
  { value: 'household_daily', label: '日用品・家庭生活' },
  { value: 'mobility_travel', label: '移動・旅行・レジャー' },
  { value: 'finance_value', label: '価格・節約・金融' },
  { value: 'sustainability', label: '環境・サステナビリティ' },
  { value: 'youth_sns', label: '若者・Z世代・SNS文化' },
  { value: 'senior_family', label: 'シニア・家族・ライフステージ' },
  { value: 'experience_personalization', label: '体験・診断・パーソナライズ' }
] as const;

const outputTemplates = [
  { value: 'auto', label: '自動' },
  { value: 'trend', label: '生活者トレンド' },
  { value: 'why', label: 'WHY深掘り' },
  { value: 'research', label: 'リサーチ課題化' },
  { value: 'proposal', label: '提案書ネタ' }
] as const;

const REPORT_REQUIREMENTS = `目的は、MJ記事群から生活者インサイトとリサーチ課題を発見することです。
answer_textを必須とし、結論、生活者動向のナラティブ、WHY3段階の説明仮説、複数仮説比較、調査論点、根拠マトリクス、反証・別解釈、品質評価を含めてください。
重要主張には根拠記事IDと記事リンクを付け、事実・推論・仮説・未検証を分離してください。記事にないことを断定せず、弱い推論は調査が必要と明記してください。`;

type ScopeMode = 'all' | 'category';
type CategoryId = typeof categories[number]['value'];
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function jobRunState(job: JsonRecord, fallback: {
  query: string;
  model: string;
  target_scope: ScopeMode;
  output_template: string;
}) {
  const request = isRecord(job.request_json) ? job.request_json : {};
  const createdAt = text(job.created_at);
  const createdMs = createdAt ? Date.parse(createdAt) : Date.now();
  return {
    status: text(job.status) === 'running' ? 'running' : 'queued',
    query: text(job.user_query || request.query) || fallback.query,
    model: text(request.model) || fallback.model,
    target_scope: text(request.target_scope) || fallback.target_scope,
    output_template: text(request.output_template) || fallback.output_template,
    started_at: Number.isNaN(createdMs) ? Date.now() : createdMs,
    updated_at: Date.now(),
    progress: Number(job.progress || 3),
    stage: text(job.stage) || 'ジョブを作成しました',
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
  const [model, setModel] = useState('gpt-5-mini');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [categoryId, setCategoryId] = useState<CategoryId>(categories[0].value);
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
        headers: {
          'content-type': 'application/json',
          'x-app-password': password
        },
        body: JSON.stringify({
          query: trimmed,
          model,
          target_scope: scopeMode,
          category_id: scopeMode === 'category' ? categoryId : undefined,
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
        saveRun(jobRunState(job, {
          query: trimmed,
          model,
          target_scope: scopeMode,
          output_template: outputTemplate
        }));
        router.push('/reports');
        return;
      }

      if (!response.ok || !jobId) {
        throw new Error(text(isRecord(json) ? json.error : '') || response.statusText || 'ジョブ作成に失敗しました');
      }

      saveRun(jobRunState(job, {
        query: trimmed,
        model,
        target_scope: scopeMode,
        output_template: outputTemplate
      }));
      router.push('/reports');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ジョブ作成に失敗しました');
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div>
        <h1 className="text-xl font-black">レポート生成</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          最新の記事母集団に合う本文読解runを自動作成し、バッチ処理を再開可能なジョブとして進めます。本文読解と品質ゲートを通過した結果だけを正式レポートとして保存します。
        </p>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="block md:col-span-2">
          <span className="text-sm font-bold text-zinc-700">分析指示</span>
          <textarea
            className="input mt-2 min-h-36"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例：全期間の記事から、価格上昇下で生活者が何を維持し、何を削っているかを根拠付きで分析"
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="text-sm font-bold text-zinc-700">分析対象</span>
          <select className="input mt-2" value={scopeMode} onChange={(event) => setScopeMode(event.target.value as ScopeMode)} disabled={busy}>
            <option value="all">全記事</option>
            <option value="category">カテゴリ限定</option>
          </select>
        </label>

        {scopeMode === 'category' && (
          <label className="block">
            <span className="text-sm font-bold text-zinc-700">カテゴリ</span>
            <select className="input mt-2" value={categoryId} onChange={(event) => setCategoryId(event.target.value as CategoryId)} disabled={busy}>
              {categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
            </select>
          </label>
        )}

        <label className="block">
          <span className="text-sm font-bold text-zinc-700">最終レポートモデル</span>
          <select className="input mt-2" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
            {models.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <p className="mt-1 text-xs leading-5 text-zinc-500">本文読解バッチは低コストモデルを使用し、ここでは最終統合モデルだけを選びます。</p>
        </label>

        <label className="block">
          <span className="text-sm font-bold text-zinc-700">出力形式</span>
          <select className="input mt-2" value={outputTemplate} onChange={(event) => setOutputTemplate(event.target.value)} disabled={busy}>
            {outputTemplates.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" type="button" onClick={submit} disabled={busy || !query.trim()}>
          {busy ? 'ジョブを作成中' : 'レポート生成を開始'}
        </button>
        <p className="text-xs leading-5 text-zinc-500">処理状態はDBとこのブラウザに保存されます。タブやブラウザを閉じても、次回表示時に未完了ジョブを再開します。</p>
      </div>
    </div>
  );
}

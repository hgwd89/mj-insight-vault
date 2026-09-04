import { neonDataFetch, parseUpstreamJson } from '@/lib/neonCloud';

export type JsonRecord = Record<string, unknown>;

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export async function listReports(jwt: string, limit = 100, offset = 0) {
  const response = await neonDataFetch(
    `vault_reports?select=*&hidden=eq.false&order=created_at.desc&limit=${Math.max(1, Math.min(200, limit))}&offset=${Math.max(0, offset)}`,
    jwt,
    { method: 'GET' }
  );
  const json = await parseUpstreamJson(response, 'レポート一覧を取得できませんでした。');
  return Array.isArray(json) ? json as JsonRecord[] : [];
}

export async function getReport(jwt: string, id: string) {
  const response = await neonDataFetch(`vault_reports?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, jwt, { method: 'GET' });
  const json = await parseUpstreamJson(response, 'レポートを取得できませんでした。');
  return Array.isArray(json) ? json[0] as JsonRecord | undefined : undefined;
}

export async function patchReport(jwt: string, id: string, patch: JsonRecord) {
  const response = await neonDataFetch(`vault_reports?id=eq.${encodeURIComponent(id)}&select=*`, jwt, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
  const json = await parseUpstreamJson(response, 'レポートを更新できませんでした。');
  return Array.isArray(json) ? json[0] as JsonRecord | undefined : undefined;
}

export async function getJob(jwt: string, id: string) {
  const response = await neonDataFetch(`vault_report_jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, jwt, { method: 'GET' });
  const json = await parseUpstreamJson(response, 'レポートジョブを取得できませんでした。');
  return Array.isArray(json) ? json[0] as JsonRecord | undefined : undefined;
}

export async function latestActiveJob(jwt: string) {
  const response = await neonDataFetch('vault_report_jobs?select=*&status=in.(queued,running)&order=created_at.desc&limit=1', jwt, { method: 'GET' });
  const json = await parseUpstreamJson(response, '未完了レポートジョブを取得できませんでした。');
  return Array.isArray(json) ? json[0] as JsonRecord | undefined : undefined;
}

export async function createJob(jwt: string, request: JsonRecord, query: string) {
  const response = await neonDataFetch('vault_report_jobs?select=*', jwt, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'queued', progress: 3, stage: 'ジョブを作成しました', user_query: query,
      request_json: request, heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString()
    })
  });
  const json = await parseUpstreamJson(response, 'レポートジョブを作成できませんでした。');
  return Array.isArray(json) ? json[0] as JsonRecord | undefined : undefined;
}

export async function patchJob(jwt: string, id: string, patch: JsonRecord) {
  const response = await neonDataFetch(`vault_report_jobs?id=eq.${encodeURIComponent(id)}&select=*`, jwt, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, heartbeat_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  });
  const json = await parseUpstreamJson(response, 'レポートジョブを更新できませんでした。');
  return Array.isArray(json) ? json[0] as JsonRecord | undefined : undefined;
}

export async function createReport(jwt: string, payload: JsonRecord) {
  const response = await neonDataFetch('vault_reports?select=*', jwt, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(payload)
  });
  const json = await parseUpstreamJson(response, 'レポートを保存できませんでした。');
  return Array.isArray(json) ? json[0] as JsonRecord | undefined : undefined;
}

export async function listReportArticles(jwt: string, ids: string[], includeOcr = false) {
  if (!ids.length) return [];
  const select = includeOcr ? 'id,title,ocr_text_raw,ocr_text_verified,verification_status,created_at' : 'id,title,verification_status,created_at';
  const encoded = ids.map((id) => id.replace(/[^0-9a-fA-F-]/g, '')).filter(Boolean).join(',');
  const response = await neonDataFetch(`vault_articles?id=in.(${encoded})&select=${encodeURIComponent(select)}&limit=${Math.min(500, ids.length)}`, jwt, { method: 'GET' });
  const json = await parseUpstreamJson(response, 'レポート根拠記事を取得できませんでした。');
  const rows = Array.isArray(json) ? json as JsonRecord[] : [];
  const byId = new Map(rows.map((row) => [text(row.id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as JsonRecord[];
}

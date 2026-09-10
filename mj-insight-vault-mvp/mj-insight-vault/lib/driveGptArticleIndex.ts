import { createSign } from 'node:crypto';
import { neonDataFetch, parseUpstreamJson } from '@/lib/neonCloud';

const DEFAULT_ARTICLE_INDEX_SHEET_ID = '1TpPKcNO_yH5DiZYckE-1LDKkfJ6ao6KB31_IBKbq4Kc';
const SHEET_NAME = 'Articles';
const ARTICLE_TEXT_LIMIT = 12000;

type GoogleServiceAccount = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

type ValidGoogleServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type DriveGptArticleIndexRow = {
  articleId: string;
  sourceFileId: string;
  articleSequence: number;
  articleDate?: string | null;
  title: string;
  articleText: string;
  originalFileName: string;
  originalDriveFileId: string;
  verificationStatus: string;
  verificationVersion: string;
  updatedAt: string;
};

let tokenCache: { token: string; expiresAt: number } | null = null;

function clean(value: unknown, max = 50000) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max)
    : '';
}

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function credentialsFromEnv(): ValidGoogleServiceAccount {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS || '';
  let credentials: GoogleServiceAccount;
  try {
    credentials = JSON.parse(raw) as GoogleServiceAccount;
  } catch {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is not valid JSON.');
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is incomplete.');
  }
  return {
    client_email: credentials.client_email,
    private_key: credentials.private_key,
    token_uri: credentials.token_uri
  };
}

async function googleSheetsToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 60) return tokenCache.token;

  const credentials = credentialsFromEnv();
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }))}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(credentials.private_key.replace(/\\n/g, '\n'));

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64Url(signature)}`
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheets OAuth ${response.status}: ${text.slice(0, 700)}`);
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Google Sheets OAuth token missing.');
  tokenCache = { token: json.access_token, expiresAt: now + (json.expires_in || 3600) };
  return tokenCache.token;
}

function spreadsheetId() {
  return process.env.GOOGLE_DRIVE_GPT_ARTICLE_INDEX_SHEET_ID?.trim() || DEFAULT_ARTICLE_INDEX_SHEET_ID;
}

async function sheetsFetch(path: string, init?: RequestInit) {
  const token = await googleSheetsToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId())}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers || {})
    },
    cache: 'no-store'
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheets API ${response.status}: ${text.slice(0, 1200)}`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function articleKey(row: DriveGptArticleIndexRow) {
  return `${row.sourceFileId}:${row.articleSequence}`;
}

function driveUrl(fileId: string) {
  return fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : '';
}

function values(row: DriveGptArticleIndexRow) {
  return [
    articleKey(row),
    clean(row.articleId, 120),
    clean(row.sourceFileId, 120),
    row.articleSequence,
    clean(row.articleDate, 32),
    clean(row.title, 1000),
    clean(row.articleText, ARTICLE_TEXT_LIMIT),
    clean(row.originalFileName, 1000),
    driveUrl(clean(row.originalDriveFileId, 256)),
    clean(row.verificationStatus, 100),
    clean(row.verificationVersion, 200),
    clean(row.updatedAt, 64)
  ];
}

async function clearArticleRows() {
  const range = encodeURIComponent(`${SHEET_NAME}!A2:L5000`);
  await sheetsFetch(`/values/${range}:clear`, { method: 'POST', body: '{}' });
}

async function writeRowsAt(startRow: number, rows: DriveGptArticleIndexRow[]) {
  if (!rows.length) return;
  const endRow = startRow + rows.length - 1;
  const rangeText = `${SHEET_NAME}!A${startRow}:L${endRow}`;
  const range = encodeURIComponent(rangeText);
  await sheetsFetch(`/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ range: rangeText, majorDimension: 'ROWS', values: rows.map(values) })
  });
}

export async function replaceDriveGptArticleIndex(rows: DriveGptArticleIndexRow[]) {
  await clearArticleRows();
  for (let index = 0; index < rows.length; index += 100) {
    await writeRowsAt(index + 2, rows.slice(index, index + 100));
  }
  return { sheet_id: spreadsheetId(), indexed: rows.length };
}

export async function upsertDriveGptArticleIndex(rows: DriveGptArticleIndexRow[]) {
  if (!rows.length) return { sheet_id: spreadsheetId(), indexed: 0, updated: 0, appended: 0 };

  const keyRange = encodeURIComponent(`${SHEET_NAME}!A2:A5000`);
  const existing = await sheetsFetch(`/values/${keyRange}?majorDimension=COLUMNS`, { method: 'GET' }) as {
    values?: string[][];
  };
  const keys = existing.values?.[0] || [];
  const rowByKey = new Map<string, number>();
  keys.forEach((key, index) => {
    if (key) rowByKey.set(String(key), index + 2);
  });

  let nextRow = keys.length + 2;
  let updated = 0;
  let appended = 0;
  const data = rows.map((row) => {
    const key = articleKey(row);
    const existingRow = rowByKey.get(key);
    const rowNumber = existingRow || nextRow++;
    if (existingRow) updated += 1;
    else appended += 1;
    return { range: `${SHEET_NAME}!A${rowNumber}:L${rowNumber}`, values: [values(row)] };
  });

  await sheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data })
  });
  return { sheet_id: spreadsheetId(), indexed: rows.length, updated, appended };
}

async function loadAllSources(jwt: string) {
  const sources = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < 10000; offset += 500) {
    const response = await neonDataFetch(
      `vault_source_files?source_status=neq.e2e_test&select=id,drive_file_id,file_name,article_date&order=created_at.asc&limit=500&offset=${offset}`,
      jwt,
      { method: 'GET' }
    );
    const json = await parseUpstreamJson(response, 'GPT記事索引用の原本情報を取得できませんでした。');
    const chunk = Array.isArray(json) ? json as Array<Record<string, unknown>> : [];
    for (const source of chunk) {
      const id = clean(source.id, 120);
      if (id) sources.set(id, source);
    }
    if (chunk.length < 500) break;
  }
  return sources;
}

export async function rebuildDriveGptArticleIndex(jwt: string) {
  const sources = await loadAllSources(jwt);
  const rows: DriveGptArticleIndexRow[] = [];

  for (let offset = 0; offset < 20000; offset += 200) {
    const response = await neonDataFetch(
      `vault_articles?article_sequence=gt.0&verification_status=eq.article_organized&select=id,source_file_id,article_sequence,title,ocr_text_raw,ocr_text_verified,verification_status,verification_version,updated_at&order=updated_at.asc&limit=200&offset=${offset}`,
      jwt,
      { method: 'GET' }
    );
    const json = await parseUpstreamJson(response, 'GPT記事索引用の記事を取得できませんでした。');
    const chunk = Array.isArray(json) ? json as Array<Record<string, unknown>> : [];

    for (const article of chunk) {
      const sourceFileId = clean(article.source_file_id, 120);
      const source = sources.get(sourceFileId);
      if (!source) continue;
      const sequence = Number(article.article_sequence || 0);
      if (!Number.isFinite(sequence) || sequence <= 0) continue;
      rows.push({
        articleId: clean(article.id, 120),
        sourceFileId,
        articleSequence: sequence,
        articleDate: clean(source.article_date, 32),
        title: clean(article.title, 1000),
        articleText: clean(article.ocr_text_verified, ARTICLE_TEXT_LIMIT) || clean(article.ocr_text_raw, ARTICLE_TEXT_LIMIT),
        originalFileName: clean(source.file_name, 1000),
        originalDriveFileId: clean(source.drive_file_id, 256),
        verificationStatus: clean(article.verification_status, 100),
        verificationVersion: clean(article.verification_version, 200),
        updatedAt: clean(article.updated_at, 64)
      });
    }
    if (chunk.length < 200) break;
  }

  const result = await replaceDriveGptArticleIndex(rows);
  return { ...result, source_count: sources.size };
}

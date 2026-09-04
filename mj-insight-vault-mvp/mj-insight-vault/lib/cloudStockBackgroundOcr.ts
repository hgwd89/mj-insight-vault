import { createHash } from 'node:crypto';
import { downloadGoogleDriveFile } from '@/lib/googleDriveRead';
import { organizeNeonSourceArticles } from '@/lib/neonArticleOrganization';
import { normalizeOcrText } from '@/lib/text';
import { runDocumentOcr } from '@/lib/vision';
import {
  extractNeonCookieHeader,
  fetchNeonJwt,
  neonAuthFetch,
  neonDataFetch,
  parseUpstreamJson
} from '@/lib/neonCloud';

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const STALE_PROCESSING_MS = 15 * 60 * 1000;

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function ownerCredentials() {
  const appPassword = process.env.APP_PASSWORD || '';
  if (!appPassword) throw new Error('APP_PASSWORD is not configured.');
  const digest = createHash('sha256').update(`mj-neon-owner-v1:${appPassword}`, 'utf8').digest('hex');
  const password = `${createHash('sha256').update(`mj-neon-password-v1:${appPassword}`, 'utf8').digest('base64url')}Aa1!`;
  return {
    email: `mj-vault-${digest.slice(0, 20)}@example.com`,
    password,
    name: 'MJ Insight Vault Owner'
  };
}

export function backgroundWorkerToken() {
  const appPassword = process.env.APP_PASSWORD || '';
  if (!appPassword) throw new Error('APP_PASSWORD is not configured.');
  return createHash('sha256')
    .update(`mj-background-ocr-worker-v1:${appPassword}`, 'utf8')
    .digest('base64url');
}

export async function getOwnerNeonJwt() {
  const credentials = ownerCredentials();
  let upstream = await neonAuthFetch('/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: credentials.email, password: credentials.password, rememberMe: true })
  });

  if (!upstream.ok && [400, 401, 404].includes(upstream.status)) {
    upstream = await neonAuthFetch('/sign-up/email', {
      method: 'POST',
      body: JSON.stringify(credentials)
    });
  }

  await parseUpstreamJson(upstream, 'Neon owner sessionを作成できませんでした。');
  const cookieHeader = extractNeonCookieHeader(upstream.headers);
  if (!cookieHeader) throw new Error('Neon Auth session cookie was not returned.');
  return fetchNeonJwt(cookieHeader);
}

export async function resetFailedOcr(jwt: string) {
  const response = await neonDataFetch(
    'vault_source_files?ocr_status=eq.failed&source_status=neq.e2e_test',
    jwt,
    {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ocr_status: 'not_started', updated_at: new Date().toISOString() })
    }
  );
  await parseUpstreamJson(response, '失敗OCRの再試行準備に失敗しました。');
}

async function resetStaleProcessing(jwt: string) {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  const response = await neonDataFetch(
    `vault_source_files?ocr_status=eq.processing&updated_at=lt.${encodeURIComponent(cutoff)}&source_status=neq.e2e_test`,
    jwt,
    {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ocr_status: 'not_started', updated_at: new Date().toISOString() })
    }
  );
  await parseUpstreamJson(response, '停止中OCRの復旧に失敗しました。');
}

export async function claimNextOcr(jwt: string) {
  await resetStaleProcessing(jwt);
  const response = await neonDataFetch(
    'vault_source_files?select=id,drive_file_id,file_name,mime_type,ocr_status&ocr_status=eq.not_started&mime_type=in.(image/jpeg,image/png,image/webp)&source_status=neq.e2e_test&order=created_at.asc&limit=8',
    jwt,
    { method: 'GET' }
  );
  const json = await parseUpstreamJson(response, '未OCR資料を取得できませんでした。');
  const rows = Array.isArray(json) ? json as Array<Record<string, unknown>> : [];

  for (const source of rows) {
    const sourceFileId = clean(source.id, 100);
    if (!sourceFileId) continue;
    const claim = await neonDataFetch(
      `vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}&ocr_status=eq.not_started`,
      jwt,
      {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ ocr_status: 'processing', updated_at: new Date().toISOString() })
      }
    );
    const claimedJson = await parseUpstreamJson(claim, 'OCR資料を確保できませんでした。');
    const claimed = Array.isArray(claimedJson) ? claimedJson[0] as Record<string, unknown> | undefined : undefined;
    if (claimed) return { ...source, ...claimed };
  }

  return null;
}

export async function runClaimedOcr(jwt: string, source: Record<string, unknown>) {
  const sourceFileId = clean(source.id, 100);
  const driveFileId = clean(source.drive_file_id, 256);
  const mimeType = clean(source.mime_type, 200).toLowerCase();
  if (!sourceFileId || !driveFileId) throw new Error('OCR対象資料のIDが不正です。');
  if (!IMAGE_MIME_TYPES.includes(mimeType)) throw new Error('OCR対象外のファイル形式です。');

  try {
    const existingResponse = await neonDataFetch(
      `vault_articles?source_file_id=eq.${encodeURIComponent(sourceFileId)}&article_sequence=eq.0&select=id,ocr_text_raw&limit=1`,
      jwt,
      { method: 'GET' }
    );
    const existingJson = await parseUpstreamJson(existingResponse, 'OCR済みデータの確認に失敗しました。');
    const existing = Array.isArray(existingJson) ? existingJson[0] as Record<string, unknown> | undefined : undefined;
    const existingText = clean(existing?.ocr_text_raw, 200000);

    if (!existingText) {
      const buffer = await downloadGoogleDriveFile(driveFileId);
      const ocr = await runDocumentOcr(buffer);
      const ocrText = normalizeOcrText(ocr.text || '');
      const articleResponse = await neonDataFetch(
        'vault_articles?on_conflict=source_file_id,article_sequence&select=id,source_file_id,article_sequence,verification_status',
        jwt,
        {
          method: 'POST',
          headers: { prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            source_file_id: sourceFileId,
            article_sequence: 0,
            title: clean(source.file_name, 500) || 'ページ全体OCR',
            ocr_text_raw: ocrText,
            ocr_text_verified: null,
            verification_version: 'drive-neon-source-ocr-v1',
            verification_status: 'source_ocr_raw',
            confidence: null,
            updated_at: new Date().toISOString()
          })
        }
      );
      await parseUpstreamJson(articleResponse, 'OCR本文をNeonへ保存できませんでした。');
    }

    const done = await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, jwt, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ocr_status: 'done', updated_at: new Date().toISOString() })
    });
    await parseUpstreamJson(done, 'OCR完了状態を保存できませんでした。');
    return { sourceFileId };
  } catch (error) {
    await neonDataFetch(`vault_source_files?id=eq.${encodeURIComponent(sourceFileId)}`, jwt, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ocr_status: 'failed', updated_at: new Date().toISOString() })
    }).catch(() => null);
    throw error;
  }
}

export async function organizeOneSource(jwt: string, sourceFileId: string) {
  return organizeNeonSourceArticles({ jwt, sourceFileId, force: false });
}

export async function pendingOcrCount(jwt: string) {
  const response = await neonDataFetch(
    'vault_source_files?select=id&ocr_status=in.(not_started,processing)&mime_type=in.(image/jpeg,image/png,image/webp)&source_status=neq.e2e_test&limit=5000',
    jwt,
    { method: 'GET' }
  );
  const json = await parseUpstreamJson(response, 'OCR進捗を取得できませんでした。');
  return Array.isArray(json) ? json.length : 0;
}

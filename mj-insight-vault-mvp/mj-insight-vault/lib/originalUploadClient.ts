type OriginalUploadTicket = {
  path: string;
  signed_url?: string;
  token?: string;
  expires_in_seconds?: number;
  already_registered?: boolean;
  source_image_id?: string;
  original_sha256?: string;
};

function responseMessage(value: unknown, fallback: string) {
  if (value && typeof value === 'object' && 'error' in value && typeof (value as { error?: unknown }).error === 'string') {
    return String((value as { error: string }).error);
  }
  return fallback;
}

function mimeTypeFor(file: File) {
  const lower = file.name.toLowerCase();
  if (file.type) return file.type.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

async function sha256File(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadOriginalImageDirect(input: {
  password: string;
  batchId: string;
  file: File;
  index: number;
}) {
  const mimeType = mimeTypeFor(input.file);
  const originalSha256 = await sha256File(input.file);
  const ticketRes = await fetch('/api/upload/original-sign', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-app-password': input.password
    },
    body: JSON.stringify({
      batch_id: input.batchId,
      index: input.index + 1,
      file_name: input.file.name,
      mime_type: mimeType,
      file_size: input.file.size,
      original_sha256: originalSha256
    })
  });
  const ticketJson = await ticketRes.json().catch(() => ({})) as OriginalUploadTicket & { error?: string };
  if (!ticketRes.ok || !ticketJson.path) {
    throw new Error(responseMessage(ticketJson, '原画像の保存URLを作成できませんでした'));
  }

  if (!ticketJson.already_registered) {
    if (!ticketJson.signed_url || !ticketJson.token) throw new Error('原画像のsigned upload tokenがありません');
    // Match Supabase Storage uploadToSignedUrl wire format: PUT multipart body
    // with cacheControl and x-upsert. The one-time signed token is embedded in
    // signed_url, so no service-role credential reaches the browser.
    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', input.file);
    const uploadRes = await fetch(ticketJson.signed_url, {
      method: 'PUT',
      headers: { 'x-upsert': 'true' },
      body
    });
    if (!uploadRes.ok) {
      const responseBody = await uploadRes.text().catch(() => '');
      throw new Error(`原画像のStorage保存に失敗しました: ${uploadRes.status} ${responseBody.slice(0, 500)}`);
    }
  }

  return {
    path: ticketJson.path,
    originalFileName: input.file.name,
    originalMimeType: mimeType,
    originalSizeBytes: input.file.size,
    originalSha256,
    alreadyRegisteredSourceImageId: ticketJson.source_image_id || ''
  };
}

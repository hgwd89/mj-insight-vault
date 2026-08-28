import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import {
  backupImageToGoogleDrive,
  findGoogleDriveFileByName,
  resolveWritableGoogleDriveFolder
} from '@/lib/googleDriveBackup';
import { GOOGLE_DRIVE_ORIGINALS_FOLDER_ID } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SCAN_PAGE_SIZE = 500;
const MAX_SCAN_OBJECTS = 5000;
const MAX_BATCH_OBJECTS = 2;
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

type LegacyObject = {
  path: string;
  size: number | null;
  mime_type: string | null;
  updated_at: string | null;
};

function cleanPath(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/^\/+/, '').slice(0, 2000) : '';
}

function metadataNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : null;
}

function metadataText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;
}

async function scanLegacyStorage(): Promise<LegacyObject[]> {
  const queue = [''];
  const seen = new Set<string>();
  const objects: LegacyObject[] = [];

  while (queue.length && objects.length < MAX_SCAN_OBJECTS) {
    const prefix = queue.shift() || '';
    if (seen.has(prefix)) continue;
    seen.add(prefix);

    let offset = 0;
    while (objects.length < MAX_SCAN_OBJECTS) {
      const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).list(prefix, {
        limit: SCAN_PAGE_SIZE,
        offset,
        sortBy: { column: 'name', order: 'asc' }
      });
      if (error) throw new Error(`Supabase Storage list failed at ${prefix || '/'}: ${error.message}`);
      const rows = data || [];

      for (const item of rows) {
        const childPath = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id) {
          const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
          objects.push({
            path: childPath,
            size: metadataNumber(metadata.size),
            mime_type: metadataText(metadata.mimetype || metadata.contentType),
            updated_at: item.updated_at || null
          });
          if (objects.length >= MAX_SCAN_OBJECTS) break;
        } else if (item.name && item.name !== '.emptyFolderPlaceholder') {
          queue.push(childPath);
        }
      }

      if (rows.length < SCAN_PAGE_SIZE) break;
      offset += SCAN_PAGE_SIZE;
    }
  }

  return objects;
}

function legacyDriveName(sourcePath: string) {
  const hash = createHash('sha256').update(`${STORAGE_BUCKET}:${sourcePath}`).digest('hex').slice(0, 12);
  const base = sourcePath.split('/').filter(Boolean).pop() || 'legacy-object';
  const safeBase = base.replace(/[\\/:*?"<>|]/g, '_').slice(-220);
  return `legacy-supabase__${hash}__${safeBase}`;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const objects = await scanLegacyStorage();
    const totalBytes = objects.reduce((sum, item) => sum + (item.size || 0), 0);
    return Response.json({
      ok: true,
      bucket: STORAGE_BUCKET,
      object_count: objects.length,
      total_bytes_known: totalBytes,
      truncated: objects.length >= MAX_SCAN_OBJECTS,
      objects
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const requested = Array.isArray(body.paths) ? body.paths.map(cleanPath).filter(Boolean) : [];
    if (!requested.length) return Response.json({ error: 'paths are required' }, { status: 400 });
    if (requested.length > MAX_BATCH_OBJECTS) {
      return Response.json({ error: `一度に最大${MAX_BATCH_OBJECTS}件です。`, max_batch_objects: MAX_BATCH_OBJECTS }, { status: 400 });
    }

    const destination = await resolveWritableGoogleDriveFolder(GOOGLE_DRIVE_ORIGINALS_FOLDER_ID);
    if (!destination.ok) {
      return Response.json({ error: destination.error || 'Google Drive destination is not writable.' }, { status: 503 });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const sourcePath of requested) {
      try {
        const driveFileName = legacyDriveName(sourcePath);
        const originalFileName = sourcePath.split('/').filter(Boolean).pop() || sourcePath;
        const existing = await findGoogleDriveFileByName(destination.folderId, driveFileName);
        if (existing.error) throw new Error(existing.error);

        if (existing.found && existing.file_id) {
          results.push({
            ok: true,
            reused: true,
            source_path: sourcePath,
            source_bucket: STORAGE_BUCKET,
            original_file_name: originalFileName,
            mime_type: existing.mime_type || null,
            file_size_bytes: existing.size ?? null,
            drive_file_id: existing.file_id,
            drive_folder_id: destination.folderId,
            drive_file_name: existing.file_name || driveFileName,
            web_view_link: existing.web_view_link || null
          });
          continue;
        }

        const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(sourcePath);
        if (error || !data) throw new Error(error?.message || 'Supabase Storage download returned no data.');
        const buffer = Buffer.from(await data.arrayBuffer());
        if (buffer.length > MAX_OBJECT_BYTES) {
          throw new Error(`25MB上限を超えています: ${buffer.length} bytes`);
        }

        const hash = createHash('sha256').update(`${STORAGE_BUCKET}:${sourcePath}`).digest('hex');
        const mimeType = data.type || 'application/octet-stream';
        const drive = await backupImageToGoogleDrive({
          buffer,
          fileName: driveFileName,
          mimeType,
          batchId: `legacy-supabase-${STORAGE_BUCKET}`.slice(0, 120),
          index: Number.parseInt(hash.slice(0, 8), 16),
          folderId: destination.folderId,
          description: `MJ Insight Vault legacy Supabase Storage copy. bucket=${STORAGE_BUCKET}; path=${sourcePath}. Source is retained in Supabase.`
        });
        if (!drive.ok || !drive.file_id) throw new Error(drive.error || 'Google Drive upload failed.');

        results.push({
          ok: true,
          reused: false,
          source_path: sourcePath,
          source_bucket: STORAGE_BUCKET,
          original_file_name: originalFileName,
          mime_type: mimeType,
          file_size_bytes: buffer.length,
          drive_file_id: drive.file_id,
          drive_folder_id: drive.folder_id || destination.folderId,
          drive_file_name: driveFileName,
          web_view_link: drive.web_view_link || null
        });
      } catch (error) {
        results.push({
          ok: false,
          source_path: sourcePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return Response.json({
      ok: results.every((row) => row.ok === true),
      copied: results.filter((row) => row.ok === true && row.reused !== true).length,
      reused: results.filter((row) => row.ok === true && row.reused === true).length,
      failed: results.filter((row) => row.ok !== true).length,
      source_deleted: false,
      downstream_started: false,
      results
    });
  } catch (error) {
    return jsonError(error);
  }
}

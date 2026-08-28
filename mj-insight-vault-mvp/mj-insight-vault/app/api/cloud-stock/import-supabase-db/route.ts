import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_PAGE = 25;

const ESSENTIAL_TABLES = [
  'articles',
  'article_tags',
  'article_profiles',
  'analysis_categories',
  'article_category_memberships',
  'source_page_article_inventory_jobs_v1',
  'chat_reports',
  'full_corpus_scan_runs',
  'formal_corpus_articles_v1',
  'concept_clusters'
] as const;

type EssentialTable = typeof ESSENTIAL_TABLES[number];

type JsonRecord = Record<string, unknown>;

function isEssentialTable(value: unknown): value is EssentialTable {
  return typeof value === 'string' && (ESSENTIAL_TABLES as readonly string[]).includes(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
  }
  return value;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function rowPrimaryKey(row: JsonRecord) {
  for (const key of ['id', 'job_id', 'run_id', 'report_id', 'article_id', 'category_id']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return `${key}:${value.trim()}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `${key}:${value}`;
  }
  return `sha256:${createHash('sha256').update(canonicalJson(row)).digest('hex')}`;
}

function archiveRows(rows: JsonRecord[]) {
  return rows.map((row) => {
    const canonical = canonicalJson(row);
    return {
      source_pk: rowPrimaryKey(row),
      payload: row,
      payload_sha256: createHash('sha256').update(canonical).digest('hex')
    };
  });
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const response = await neonDataFetch('rpc/vault_legacy_archive_status_v1', jwt, {
      method: 'POST',
      body: JSON.stringify({})
    });
    const status = await parseUpstreamJson(response, 'Neon legacy DB archive status failed.');
    return Response.json({
      ok: true,
      essential_tables: ESSENTIAL_TABLES,
      status: Array.isArray(status) ? status : [],
      source_deleted: false,
      deletion_released: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const table = body.table;
    if (!isEssentialTable(table)) {
      return Response.json({ error: 'table is not in the essential rescue allow-list' }, { status: 400 });
    }

    const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(body.limit) || MAX_PAGE)));

    const { data, error } = await supabaseAdmin
      .from(table)
      .select('*')
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Supabase ${table} read failed: ${error.message}`);
    const rows = Array.isArray(data) ? data as JsonRecord[] : [];
    const archivedRows = archiveRows(rows);

    if (archivedRows.length > 0) {
      const response = await neonDataFetch('rpc/vault_archive_legacy_json_v1', jwt, {
        method: 'POST',
        body: JSON.stringify({ p_source_table: table, p_rows: archivedRows })
      });
      await parseUpstreamJson(response, `Neon archive failed for ${table}.`);
    }

    return Response.json({
      ok: true,
      table,
      offset,
      requested_limit: limit,
      archived: archivedRows.length,
      next_offset: offset + rows.length,
      has_more: rows.length === limit,
      source_deleted: false,
      downstream_started: false
    });
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const paused = {
  ok: true,
  status: 'paused_nano_stock_ocr_only',
  historical_canary_execution: false,
  full_rollout_execution: false,
  note: 'Historical OCR consensus is paused. New source-image stock and explicit OCR-only ingestion remain the active operating mode.'
};

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(paused);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(paused);
  } catch (error) {
    return jsonError(error);
  }
}

import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    await req.json().catch(() => ({}));
    return Response.json({
      ok: false,
      status: 'retired',
      error: 'The whole-article independent OCR canary probe is retired. Current canary execution is isolated piece OCR at /api/internal/ocr-consensus-piece-v18.'
    }, { status: 410 });
  } catch (error) {
    return jsonError(error);
  }
}

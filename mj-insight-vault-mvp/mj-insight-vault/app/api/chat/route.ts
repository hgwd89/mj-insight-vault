import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { runChatAnalysis } from '@/lib/chatRouteFullCorpusGuard';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    return Response.json(await runChatAnalysis(await req.json()));
  } catch (error) {
    return jsonError(error);
  }
}

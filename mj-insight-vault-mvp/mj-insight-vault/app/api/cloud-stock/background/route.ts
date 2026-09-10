import { NextRequest } from 'next/server';
import { start } from 'workflow/api';
import { jsonError, requireAppPassword } from '@/lib/auth';
import { pendingOcrCount, pendingOrganizeCount, resetFailedOcr } from '@/lib/cloudStockBackgroundOcr';
import { neonDataFetch, parseUpstreamJson, requireNeonJwt } from '@/lib/neonCloud';
import { cloudStockOcrWorkflow } from '@/workflows/cloud-stock-ocr';

export const runtime = 'nodejs';

async function countByStatus(jwt: string, status: string) {
  const response = await neonDataFetch(
    `vault_source_files?select=id&ocr_status=eq.${encodeURIComponent(status)}&mime_type=in.(image/jpeg,image/png,image/webp)&source_status=neq.e2e_test&limit=5000`,
    jwt,
    { method: 'GET' }
  );
  const json = await parseUpstreamJson(response, 'OCR状態を取得できませんでした。');
  return Array.isArray(json) ? json.length : 0;
}

export async function GET(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    const [remaining, optionalOrganizeRemaining, processing, failed] = await Promise.all([
      pendingOcrCount(jwt),
      pendingOrganizeCount(jwt),
      countByStatus(jwt, 'processing'),
      countByStatus(jwt, 'failed')
    ]);

    return Response.json({
      ok: true,
      background_enabled: true,
      durable_workflow: true,
      mode: 'ocr_only_gpt_search',
      remaining,
      organize_remaining: optionalOrganizeRemaining,
      optional_organize_remaining: optionalOrganizeRemaining,
      total_remaining: remaining,
      processing,
      failed,
      can_close_app: true,
      article_organization_required_for_search: false
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const jwt = await requireNeonJwt(req);
    await resetFailedOcr(jwt);

    const [remaining, optionalOrganizeRemaining] = await Promise.all([
      pendingOcrCount(jwt),
      pendingOrganizeCount(jwt)
    ]);

    if (remaining === 0) {
      return Response.json({
        ok: true,
        started: false,
        mode: 'ocr_only_gpt_search',
        remaining: 0,
        organize_remaining: optionalOrganizeRemaining,
        optional_organize_remaining: optionalOrganizeRemaining,
        total_remaining: 0,
        can_close_app: true,
        article_organization_required_for_search: false,
        message: `未OCR資料はありません。記事分割未実施 ${optionalOrganizeRemaining}件は任意処理で、GPT検索には不要です。`
      });
    }

    const run = await start(cloudStockOcrWorkflow, []);

    return Response.json({
      ok: true,
      started: true,
      run_id: run.runId,
      mode: 'ocr_only_gpt_search',
      remaining,
      organize_remaining: optionalOrganizeRemaining,
      optional_organize_remaining: optionalOrganizeRemaining,
      total_remaining: remaining,
      can_close_app: true,
      durable_workflow: true,
      article_organization_required_for_search: false,
      message: `バックグラウンドOCRを開始しました。未OCR ${remaining}件。OCR完了後はGPT検索可能です。記事分割未実施 ${optionalOrganizeRemaining}件は自動実行しません。`
    }, { status: 202 });
  } catch (error) {
    return jsonError(error);
  }
}

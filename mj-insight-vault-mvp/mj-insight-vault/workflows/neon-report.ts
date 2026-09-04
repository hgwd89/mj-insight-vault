type JsonRecord = Record<string, unknown>;

const GROUP_ARTICLE_LIMIT = 96;

type BeginResult = {
  request: JsonRecord;
  total: number;
};

async function beginReportJob(jobId: string): Promise<BeginResult> {
  'use step';
  const auth = await import('@/lib/cloudStockBackgroundOcr');
  const store = await import('@/lib/neonReportStore');
  const analysis = await import('@/lib/neonReportAnalysis');
  const jwt = await auth.getOwnerNeonJwt();
  const job = await store.getJob(jwt, jobId);
  if (!job) throw new Error('レポートジョブが見つかりません。');
  const request = job.request_json && typeof job.request_json === 'object' && !Array.isArray(job.request_json)
    ? job.request_json as JsonRecord
    : { query: job.user_query };
  const total = await analysis.countReportArticles(jwt);
  if (total <= 0) throw new Error('OCR済み記事がないためレポートを生成できません。');
  await store.patchJob(jwt, jobId, {
    status: 'running',
    progress: 8,
    stage: `全${total}記事を本文読解する準備をしています`,
    error_message: null,
    started_at: job.started_at || new Date().toISOString(),
    finished_at: null,
    next_retry_at: null
  });
  return { request, total };
}

async function analyzeReportGroup(jobId: string, request: JsonRecord, offset: number, groupIndex: number, total: number) {
  'use step';
  const auth = await import('@/lib/cloudStockBackgroundOcr');
  const store = await import('@/lib/neonReportStore');
  const analysis = await import('@/lib/neonReportAnalysis');
  const jwt = await auth.getOwnerNeonJwt();
  const result = await analysis.summarizeReportGroup(jwt, request, offset, groupIndex);
  const completed = Math.min(total, offset + result.rowCount);
  const progress = Math.min(82, 12 + Math.round((completed / Math.max(1, total)) * 68));
  await store.patchJob(jwt, jobId, {
    status: 'running',
    progress,
    stage: `本文読解 ${completed}/${total}記事`,
    error_message: null
  });
  return result;
}

async function finalizeReportJob(jobId: string, request: JsonRecord, summaries: string[], articleIds: string[], total: number) {
  'use step';
  const auth = await import('@/lib/cloudStockBackgroundOcr');
  const store = await import('@/lib/neonReportStore');
  const analysis = await import('@/lib/neonReportAnalysis');
  const jwt = await auth.getOwnerNeonJwt();
  const job = await store.getJob(jwt, jobId);
  if (!job) throw new Error('レポートジョブが見つかりません。');

  await store.patchJob(jwt, jobId, { progress: 86, stage: '全バッチをAAAA詳細レポートへ統合しています' });
  const result = await analysis.synthesizeReport(request, summaries, articleIds, total);
  await store.patchJob(jwt, jobId, { progress: 96, stage: '最終レポートをNeonへ保存しています' });

  const report = await store.createReport(jwt, {
    user_query: String(job.user_query || request.query || ''),
    answer_text: String(result.answer.answer_text || ''),
    answer_json: result.answer,
    related_article_ids: result.relatedArticleIds,
    report_kind: 'neon_native',
    is_formal_report: false,
    analysis_verification_status: 'neon_native_full_corpus',
    hidden: false,
    pinned: false
  });
  if (!report) throw new Error('レポート保存結果が返りませんでした。');

  const completed = await store.patchJob(jwt, jobId, {
    status: 'completed',
    progress: 100,
    stage: 'AAAA詳細レポート生成完了',
    report_id: report.id,
    result_json: {
      answer: {
        report_title: String(result.answer.report_title || 'レポート'),
        answer_text: String(result.answer.answer_text || '').slice(0, 180)
      },
      report: { id: report.id },
      analyzed_article_count: total
    },
    error_message: null,
    finished_at: new Date().toISOString(),
    next_retry_at: null
  });

  return { job: completed, report, analyzedArticleCount: total };
}

async function failReportJob(jobId: string, message: string) {
  'use step';
  const auth = await import('@/lib/cloudStockBackgroundOcr');
  const store = await import('@/lib/neonReportStore');
  const jwt = await auth.getOwnerNeonJwt();
  const job = await store.getJob(jwt, jobId);
  if (!job) return null;
  return store.patchJob(jwt, jobId, {
    status: 'failed',
    progress: 100,
    stage: '分析に失敗しました',
    error_message: message,
    finished_at: new Date().toISOString(),
    next_retry_at: null,
    attempt_count: Number(job.attempt_count || 0) + 1
  });
}

export async function neonReportWorkflow(jobId: string) {
  'use workflow';

  try {
    const begin = await beginReportJob(jobId);
    const summaries: string[] = [];
    const articleIds: string[] = [];
    let offset = 0;
    let groupIndex = 0;

    while (offset < begin.total) {
      const group = await analyzeReportGroup(jobId, begin.request, offset, groupIndex, begin.total);
      if (!group.rowCount) break;
      summaries.push(...group.summaries);
      articleIds.push(...group.articleIds);
      offset += group.rowCount;
      groupIndex += 1;
      if (group.rowCount < GROUP_ARTICLE_LIMIT) break;
    }

    if (articleIds.length !== begin.total) {
      throw new Error(`全記事読解の整合性エラー: expected=${begin.total}, analyzed=${articleIds.length}`);
    }

    return await finalizeReportJob(jobId, begin.request, summaries, articleIds, begin.total);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'レポート生成に失敗しました。';
    await failReportJob(jobId, message);
    return { failed: true, error: message };
  }
}

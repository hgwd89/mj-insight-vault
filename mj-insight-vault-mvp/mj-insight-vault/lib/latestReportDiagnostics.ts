import { supabaseAdmin } from '@/lib/supabaseAdmin';

type JsonRecord = Record<string, unknown>;

type DiagnosticCheck = {
  key: string;
  passed: boolean;
  actual: unknown;
  expected: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function qualityFailedChecks(quality: JsonRecord) {
  const direct = asArray(quality.failed_checks).map(text).filter(Boolean);
  if (direct.length) return direct;
  return asArray(quality.checks)
    .filter(isRecord)
    .filter((check) => check.passed === false)
    .map((check) => text(check.key))
    .filter(Boolean);
}

function hasArticleLinks(value: unknown) {
  return /\[[^\]]+\]\(\/articles\/[a-zA-Z0-9_-]+\)/.test(text(value));
}

export async function diagnoseLatestReport() {
  const { data: report, error } = await supabaseAdmin
    .from('chat_reports')
    .select('id, user_query, answer_text, answer_json, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!report) {
    return {
      status: 'no_report',
      score: 0,
      checks: [] as DiagnosticCheck[],
      report: null,
      summary: 'chat_reports にレポートがありません。'
    };
  }

  const answer = isRecord(report.answer_json) ? report.answer_json : {};
  const coverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  const quality = isRecord(answer.quality_gate) ? answer.quality_gate : {};
  const failedChecks = qualityFailedChecks(quality);
  const sourceArticleCount = numberValue(coverage.monthly_rollup_source_article_count);
  const totalArticleCount = numberValue(coverage.monthly_rollup_total_article_count || coverage.active_article_count || coverage.article_count);
  const finalArticleCount = numberValue(coverage.final_article_count || answer.article_count_for_report);
  const scanModel = text(coverage.scan_model || answer.scan_model);
  const retrievalMode = text(coverage.retrieval_mode || answer.retrieval_mode);
  const evidenceMode = text(coverage.evidence_selection_mode || answer.evidence_selection_mode);
  const body = text(report.answer_text || answer.answer_text);

  const checks: DiagnosticCheck[] = [
    {
      key: 'monthly_rollup_used',
      passed: coverage.monthly_rollup_used === true || answer.monthly_rollup_used === true,
      actual: coverage.monthly_rollup_used ?? answer.monthly_rollup_used,
      expected: 'true',
      severity: 'critical'
    },
    {
      key: 'monthly_rollup_coverage_complete',
      passed: coverage.monthly_rollup_coverage_complete === true || answer.monthly_rollup_coverage_complete === true,
      actual: coverage.monthly_rollup_coverage_complete ?? answer.monthly_rollup_coverage_complete,
      expected: 'true',
      severity: 'critical'
    },
    {
      key: 'monthly_rollup_article_count_match',
      passed: sourceArticleCount > 0 && totalArticleCount > 0 && sourceArticleCount === totalArticleCount,
      actual: { monthly_rollup_source_article_count: sourceArticleCount, monthly_rollup_total_article_count: totalArticleCount },
      expected: 'source article count equals total active article count',
      severity: 'critical'
    },
    {
      key: 'not_provisional',
      passed: coverage.analysis_is_provisional === false || answer.analysis_is_provisional === false,
      actual: coverage.analysis_is_provisional ?? answer.analysis_is_provisional,
      expected: 'false',
      severity: 'high'
    },
    {
      key: 'hybrid_or_monthly_scan_model',
      passed: /monthly_rollups|hybrid/.test(scanModel),
      actual: scanModel,
      expected: 'scan_model contains monthly_rollups or hybrid',
      severity: 'high'
    },
    {
      key: 'hybrid_evidence_selection',
      passed: /hybrid/.test(evidenceMode) || /hybrid/.test(retrievalMode),
      actual: { evidence_selection_mode: evidenceMode, retrieval_mode: retrievalMode },
      expected: 'hybrid evidence selection or retrieval mode',
      severity: 'high'
    },
    {
      key: 'final_evidence_count',
      passed: finalArticleCount >= 40,
      actual: finalArticleCount,
      expected: '>= 40 for all-article report with monthly rollups',
      severity: 'medium'
    },
    {
      key: 'quality_gate_present',
      passed: isRecord(quality) && asArray(quality.checks).length > 0,
      actual: { status: quality.status, check_count: asArray(quality.checks).length },
      expected: 'quality_gate with checks',
      severity: 'high'
    },
    {
      key: 'quality_gate_no_failed_checks',
      passed: failedChecks.length === 0,
      actual: failedChecks,
      expected: 'no failed checks',
      severity: 'high'
    },
    {
      key: 'negative_space_present',
      passed: asArray(answer.negative_space).length > 0,
      actual: asArray(answer.negative_space).length,
      expected: '>= 1',
      severity: 'medium'
    },
    {
      key: 'confidence_rubric_present',
      passed: asArray(answer.confidence_rubric).length > 0,
      actual: asArray(answer.confidence_rubric).length,
      expected: '>= 1',
      severity: 'medium'
    },
    {
      key: 'evidence_matrix_present',
      passed: asArray(answer.evidence_matrix).length >= 3,
      actual: asArray(answer.evidence_matrix).length,
      expected: '>= 3',
      severity: 'high'
    },
    {
      key: 'refutation_audit_present',
      passed: asArray(answer.refutation_audit).length > 0,
      actual: asArray(answer.refutation_audit).length,
      expected: '>= 1',
      severity: 'high'
    },
    {
      key: 'research_needs_present',
      passed: asArray(answer.research_needs).length > 0,
      actual: asArray(answer.research_needs).length,
      expected: '>= 1',
      severity: 'high'
    },
    {
      key: 'clickable_article_links',
      passed: hasArticleLinks(body),
      actual: hasArticleLinks(body),
      expected: 'answer_text contains clickable /articles links',
      severity: 'medium'
    }
  ];

  const weights = { critical: 25, high: 15, medium: 8, low: 3 } as const;
  const maxScore = checks.reduce((sum, check) => sum + weights[check.severity], 0);
  const earned = checks.filter((check) => check.passed).reduce((sum, check) => sum + weights[check.severity], 0);
  const score = maxScore ? Math.round((earned / maxScore) * 100) : 0;
  const criticalFailed = checks.filter((check) => !check.passed && check.severity === 'critical').map((check) => check.key);
  const highFailed = checks.filter((check) => !check.passed && check.severity === 'high').map((check) => check.key);
  const status = criticalFailed.length ? 'fail' : highFailed.length ? 'needs_review' : score >= 90 ? 'pass' : 'needs_review';

  return {
    status,
    score,
    critical_failed: criticalFailed,
    high_failed: highFailed,
    checks,
    report: {
      id: report.id,
      created_at: report.created_at,
      user_query: report.user_query,
      answer_head: body.slice(0, 400),
      source_coverage: coverage,
      quality_gate: quality
    },
    summary: status === 'pass'
      ? '最新レポートは主要品質条件を満たしています。'
      : '最新レポートは品質条件を満たしていません。failed checks を確認してください。'
  };
}

from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding='utf-8')
    if old not in source:
        raise SystemExit(f'{label}: marker not found')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


# 1) Rollups: missing month rows must not be dereferenced.
rollups = ROOT / 'app/api/rollups/monthly/route.ts'
replace_once(
    rollups,
    """function activeLease(row: RollupRow) {
  if (row.status !== 'running') return false;
""",
    """function activeLease(row: RollupRow | undefined) {
  if (!row || row.status !== 'running') return false;
""",
    'rollups activeLease null guard'
)
replace_once(
    rollups,
    """    if (row?.status === 'queued' || activeLease(row as RollupRow)) {
""",
    """    if (row?.status === 'queued' || activeLease(row)) {
""",
    'rollups activeLease call'
)


# 2) Full-corpus Writer: use the failed first draft as repair material and
#    escalate the second attempt to the analyst model instead of blind rerolling.
guard = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
replace_once(
    guard,
    """  let finalText = '';
  let finalFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
""",
    """  let finalText = '';
  let previousDraft = '';
  let finalFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
""",
    'writer preserve previous draft'
)
replace_once(
    guard,
    """    const writerPayload = finalFeedback.length
      ? {
          ...finalPayload,
          correction: {
            errors: finalFeedback,
            instruction: 'Return only a 1,600〜2,600-character Japanese Markdown report body. Do not include any URL, Markdown link, code fence, JSON, unsupported number, or unselected article.'
          }
        }
      : finalPayload;
    const finalCompletion = await timeout((signal) => openai.chat.completions.create({
      model: writerModel,
      ...(writerModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
""",
    """    const repairAttempt = attempt > 1 && Boolean(previousDraft);
    const writerPayload = finalFeedback.length
      ? {
          ...finalPayload,
          previous_draft: previousDraft,
          correction: {
            errors: finalFeedback,
            instruction: 'Rewrite and expand previous_draft into a complete 1,800〜2,600-character Japanese Markdown report. Preserve only grounded claims from ranked_themes and selected_evidence. Required sections: 統合ナラティブ, 4〜5個の主要テーマ, コーパス内反証・制約, 実務含意, 調査課題. Each major theme must state article-grounded fact, consumer interpretation, and boundary/what cannot be concluded. Do not pad with generic prose. Do not include any URL, Markdown link, code fence, JSON, unsupported number, or unselected article.'
          }
        }
      : finalPayload;
    const activeWriterModel = repairAttempt ? analystModel : writerModel;
    const finalCompletion = await timeout((signal) => openai.chat.completions.create({
      model: activeWriterModel,
      ...(activeWriterModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
""",
    'writer repair escalation'
)
replace_once(
    guard,
    """          content: 'Return only the Japanese Markdown report body. Do not return JSON, a code fence, a title wrapper, a preface, any URL, or any Markdown link. Verified article links are appended by the server. You are a skeptical senior marketing-research writer. Use only ranked_themes and selected_evidence. Do not use a legacy report template, invent evidence counts, add unlisted articles, add unsupplied numbers, or convert supply signals into consumer demand. Keep the body between 1,600 and 2,600 Japanese characters.'
""",
    """          content: 'Return only the Japanese Markdown report body. Do not return JSON, a code fence, a title wrapper, a preface, any URL, or any Markdown link. Verified article links are appended by the server. You are a skeptical senior marketing-research writer. Use only ranked_themes and selected_evidence. Do not use a legacy report template, invent evidence counts, add unlisted articles, add unsupplied numbers, or convert supply signals into consumer demand. Keep the body between 1,600 and 2,600 Japanese characters. Structure the reasoning as: 統合ナラティブ → 4〜5個の主要テーマ（各テーマで事実・生活者解釈・限界）→ コーパス内反証・制約 → 実務含意 → 調査課題. Avoid generic filler and make the cross-theme narrative explicit.'
""",
    'writer AAAA structure'
)
replace_once(
    guard,
    """    const candidateText = text(finalCompletion.choices[0]?.message.content)
      .replace(/^```(?:markdown)?\\s*/i, '')
      .replace(/\\s*```$/, '')
      .trim();
    const errors: string[] = [];
""",
    """    const candidateText = text(finalCompletion.choices[0]?.message.content)
      .replace(/^```(?:markdown)?\\s*/i, '')
      .replace(/\\s*```$/, '')
      .trim();
    previousDraft = candidateText;
    const errors: string[] = [];
""",
    'writer save candidate for repair'
)


# 3) Job runner: quality-generation failures are quality-gate responses, not generic 500s.
runner = ROOT / 'app/api/chat/jobs/[id]/run/route.ts'
replace_once(
    runner,
    """function retryDelaySeconds(failureCount: number) {
  return Math.min(300, 20 * Math.pow(2, Math.max(0, failureCount - 1)));
}
""",
    """function qualityGateError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes('final writer validation failed')
    || message.includes('theme analysis validation failed')
    || message.includes('evidence critic validation failed')
    || message.includes('semantic review failed')
    || message.includes('semantic review json invalid');
}

function retryDelaySeconds(failureCount: number) {
  return Math.min(300, 20 * Math.pow(2, Math.max(0, failureCount - 1)));
}
""",
    'job quality error classifier'
)
replace_once(
    runner,
    """      const message = errorMessage(error);
      const nextFailureCount = consecutiveFailureCount + 1;
      if (retryableError(error) && nextFailureCount <= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
""",
    """      const message = errorMessage(error);
      const nextFailureCount = consecutiveFailureCount + 1;
      if (qualityGateError(error)) {
        const failed = await updateClaimedJob(jobId, leaseToken, {
          status: 'failed',
          progress: 100,
          stage: 'quality_gate',
          error_message: message,
          attempt_count: consecutiveFailureCount,
          finished_at: new Date().toISOString(),
          next_retry_at: null
        }, true);
        return Response.json({ job: failed, blocked: true, error: message }, { status: 409 });
      }
      if (retryableError(error) && nextFailureCount <= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
""",
    'job quality error response'
)


# 4) Explicit icon metadata stops browsers from probing a missing /favicon.ico.
layout = ROOT / 'app/layout.tsx'
replace_once(
    layout,
    """  description: 'MJ記事キャプチャをOCR・蓄積・分析する個人用PWA',
  manifest: '/manifest.webmanifest'
""",
    """  description: 'MJ記事キャプチャをOCR・蓄積・分析する個人用PWA',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icon-192.png',
    apple: '/icon-192.png'
  }
""",
    'explicit favicon metadata'
)


# 5) Regression guards.
test = ROOT / 'scripts/verify-report-pipeline.mjs'
source = test.read_text(encoding='utf-8')
marker = """assertIncludes(runner, 'retry_scheduled', 'transient job failures must be retried');
"""
addition = marker + """assertIncludes(runner, 'qualityGateError', 'writer validation failures must be classified as quality-gate failures');
assertIncludes(runner, "status: 409", 'quality-gate failures must not surface as generic 500 errors');
"""
if marker not in source:
    raise SystemExit('runner regression marker not found')
source = source.replace(marker, addition, 1)
marker = """assertIncludes(guard, '最終WriterのURL・数値制約を自己修正中', 'invalid final writer prose must be retried');
"""
addition = marker + """assertIncludes(guard, 'previous_draft: previousDraft', 'writer repair must use the failed draft instead of blind rerolling');
assertIncludes(guard, 'repairAttempt ? analystModel : writerModel', 'writer repair must escalate to the analyst model');
assertIncludes(guard, '統合ナラティブ', 'final writer must synthesize an explicit cross-theme narrative');
"""
if marker not in source:
    raise SystemExit('writer regression marker not found')
source = source.replace(marker, addition, 1)
marker = """const statusRoute = read('app/api/chat/jobs/[id]/route.ts');
"""
addition = """const monthlyRollupsRoute = read('app/api/rollups/monthly/route.ts');
assertIncludes(monthlyRollupsRoute, 'function activeLease(row: RollupRow | undefined)', 'rollups page must tolerate months without an existing rollup row');
assertIncludes(monthlyRollupsRoute, 'if (!row || row.status', 'rollup lease checks must null-guard missing rows');

""" + marker
if marker not in source:
    raise SystemExit('rollups regression insertion marker not found')
source = source.replace(marker, addition, 1)
test.write_text(source, encoding='utf-8')

print('Production blocker + AAAA writer recovery patch applied.')

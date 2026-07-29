type JsonRecord = Record<string, unknown>;

const INTERNAL_KEYS = new Set([
  'report_requirements',
  'quality_instructions',
  'system_prompt',
  'analysis_instruction',
  'prompt',
  'messages'
]);

const INTERNAL_MARKERS = [
  '【レポート要件】',
  '[レポート要件]',
  'レポート要件',
  '最重要:',
  'answer_text は必須',
  'coverage_diagnosis',
  'source_coverage',
  'explanatory_hypotheses',
  'hypothesis_comparison',
  'research_needs',
  'evidence_matrix',
  '必ず以下を出してください',
  '根拠記事IDのない重要主張は禁止'
];

function cutInternalPrompt(value: string) {
  const indexes = INTERNAL_MARKERS
    .map((marker) => value.indexOf(marker))
    .filter((index) => index >= 0);
  return indexes.length ? value.slice(0, Math.min(...indexes)) : value;
}

export function sanitizeReportText(value: unknown) {
  const text = value === undefined || value === null ? '' : String(value);
  return cutInternalPrompt(text)
    .replace(/^\s*全記事を対象に、全データを広域スキャンしたうえで分析してください。[\s　]*/g, '')
    .replace(/^\s*MJ記事群から生活者動向を読み、説明仮説・根拠・調査が必要そうな論点を抽出します。[\s　]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeJson(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeReportText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item));
  if (!value || typeof value !== 'object') return value;

  const source = value as JsonRecord;
  const output: JsonRecord = {};
  for (const [key, childValue] of Object.entries(source)) {
    if (INTERNAL_KEYS.has(key)) continue;
    output[key] = sanitizeJson(childValue);
  }
  return output;
}

export function sanitizeReportForDisplay<T extends JsonRecord>(report: T): T {
  return {
    ...report,
    user_query: sanitizeReportText(report.user_query),
    answer_text: sanitizeReportText(report.answer_text),
    answer_json: sanitizeJson(report.answer_json)
  } as T;
}

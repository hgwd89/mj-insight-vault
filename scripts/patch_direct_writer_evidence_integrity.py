from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
GATE = ROOT / 'lib/chatAnalysisQualityGate.ts'


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'expected block not found in {path}: {old[:120]!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    GUARD,
    """const text = (value: unknown) => value === undefined || value === null ? '' : String(value).trim();
const record = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const records = (value: unknown) => Array.isArray(value) ? value.filter(record) : [];
const number = (value: unknown) => Number(value || 0);
const runValue = (run: Json, key: string) => number(run[key]);
""",
    """const text = (value: unknown) => value === undefined || value === null ? '' : String(value).trim();
const record = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const records = (value: unknown) => Array.isArray(value) ? value.filter(record) : [];
const number = (value: unknown) => Number(value || 0);
const runValue = (run: Json, key: string) => number(run[key]);

const STRUCTURED_TEXT_KEYS = [
  'claim', 'consumer_narrative', 'narrative', 'theme', 'signal', 'insight', 'summary',
  'text', 'title', 'label', 'description', 'observed_fact', 'fact', 'what_can_be_said'
];

function structuredText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return text(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = structuredText(item);
      if (found) return found;
    }
    return '';
  }
  if (record(value)) {
    for (const key of STRUCTURED_TEXT_KEYS) {
      const found = structuredText(value[key]);
      if (found) return found;
    }
  }
  return '';
}

function cleanText(candidates: unknown[], maxLength: number) {
  for (const candidate of candidates) {
    const value = structuredText(candidate).replace(/\\s+/g, ' ').replace(/\\[object Object\\]/gi, '').trim();
    if (value) return value.slice(0, maxLength);
  }
  return '';
}

function brokenText(value: unknown) {
  const normalized = text(value);
  return !normalized || /\\[object Object\\]|\\[object Undefined\\]|^undefined$|^null$/i.test(normalized);
}
"""
)

replace_once(
    GUARD,
    """function fact(item: Json) {
  return text(item.evidence_excerpt_or_fact || item.observed_fact || item.what_can_be_said || item.evidence_excerpt || item.excerpt || item.fact)
    .replace(/\\s+/g, ' ').slice(0, 700);
}

function claim(item: Json, summary: Json) {
  return text(item.claim || item.theme || item.signal || item.consumer_narrative || summary.consumer_narratives || summary.behavior_signals || summary.weak_signals || '記事本文で観察された事実')
    .replace(/\\s+/g, ' ').slice(0, 240);
}
""",
    """function fact(item: Json) {
  return cleanText([
    item.evidence_excerpt_or_fact, item.observed_fact, item.what_can_be_said,
    item.evidence_excerpt, item.excerpt, item.fact
  ], 700);
}

function claim(item: Json, summary: Json) {
  return cleanText([
    item.claim, item.theme, item.signal, item.consumer_narrative,
    summary.consumer_narratives, summary.behavior_signals, summary.weak_signals,
    '記事本文で観察された事実'
  ], 240);
}
"""
)

old_ensure = """function ensureRawFields(answer: Json, evidenceLookup: Evidence[], run: Json, scope: Scope) {
  const lookup = new Map(evidenceLookup.map((item) => [item.article_id, item]));
  const evidence: Json[] = [];
  const seen = new Set<string>();
  for (const item of records(answer.evidence_matrix)) {
    const id = text(item.article_id || item.id);
    const source = lookup.get(id);
    if (!source || seen.has(id)) continue;
    const evidenceFact = fact(item) || source.evidence_excerpt_or_fact;
    if (evidenceFact.length < 20) continue;
    seen.add(id);
    evidence.push({ ...item, article_id: id, headline: text(item.headline) || source.headline, article_date: text(item.article_date) || source.article_date, article_url: source.article_url, article_link: source.article_link, evidence_excerpt_or_fact: evidenceFact, evidence_strength: text(item.evidence_strength || 'B'), limitation: text(item.limitation) || '記事単独では生活者全体の需要や因果を断定できない。', synthetic_repair: false });
  }
  for (const source of evidenceLookup) {
    if (evidence.length >= 10) break;
    if (seen.has(source.article_id)) continue;
    seen.add(source.article_id);
    evidence.push({ ...source, evidence_strength: 'B', limitation: '記事本文で確認できる事実。頻度・代表性・因果は全バッチ横断と追加調査で確認する。', what_can_be_said: source.evidence_excerpt_or_fact, what_cannot_be_said: 'この記事単独では生活者全体の需要や心理を断定できない。', synthetic_repair: false, provenance: 'validated_full_corpus_batch_v2_evidence' });
  }
  answer.evidence_matrix = evidence;
  if (!records(answer.refutation_audit).length) answer.refutation_audit = [{ target_claim: '主要トレンド全体', possible_counterargument: '企業施策や商品投入が多いだけで生活者需要の変化を示していない可能性がある。', evidence_gap: '生活者本人の発話、継続購買、非購買理由、カテゴリ横断の反例。', downgrade_or_revision: '生活者側の直接証拠がない主張は仮説へ格下げする。', falsification_condition: '追加調査で行動変化が一時的・局所的・企業主導に限定される場合。', synthetic_repair: false }];
  if (!records(answer.negative_space).length) answer.negative_space = [{ expected_but_weak_or_absent_theme: '生活者本人の長期継続行動と非利用理由', why_absence_matters: '記事群は企業・市場側の情報を多く含み、心理や因果の直接証拠が弱い。', what_to_check_next: '時系列購買、非購買者インタビュー、カテゴリ外反例を確認する。', synthetic_repair: false }];
  if (!records(answer.research_needs).length) answer.research_needs = [{ question: '観察された変化は生活者本人の継続行動と選択理由で再現されるか。', why_it_matters: '市場シグナルを生活者インサイトへ昇格するため。', needed_data: '生活者発話、購買・利用継続、非利用理由、カテゴリ外反例。', method_hint: 'N1深掘り、行動ログ、定量検証。', priority: 'high', synthetic_repair: false }];
  if (!records(answer.confidence_rubric).length) answer.confidence_rubric = evidence.slice(0, 5).map((item) => ({ claim: text(item.claim || '根拠付き主張'), confidence: text(item.evidence_strength || 'B'), reason_for_confidence: text(item.evidence_excerpt_or_fact), reason_for_uncertainty: text(item.limitation), synthetic_repair: false }));

  const links = evidence.slice(0, 8).map((item) => text(item.article_link) ? `- ${text(item.claim || '根拠記事')}：${text(item.article_link)} — ${text(item.evidence_excerpt_or_fact).slice(0, 180)}` : '').filter(Boolean);
  if (links.length && !text(answer.answer_text).includes('## 根拠記事')) answer.answer_text = `${text(answer.answer_text)}\\n\\n## 根拠記事\\n${links.join('\\n')}`.trim();

  const analyzed = runValue(run, 'analyzed_article_count');
"""

new_ensure = """function ensureRawFields(answer: Json, evidenceLookup: Evidence[], run: Json, scope: Scope) {
  const lookup = new Map(evidenceLookup.map((item) => [item.article_id, item]));
  const evidence: Json[] = [];
  const seen = new Set<string>();
  for (const item of records(answer.evidence_matrix)) {
    const id = text(item.article_id || item.id);
    const source = lookup.get(id);
    if (!source || seen.has(id)) continue;
    const evidenceClaim = cleanText([item.claim, item.theme, item.insight, item.title], 240);
    const evidenceFact = fact(item);
    const whatCanBeSaid = cleanText([item.what_can_be_said, evidenceFact], 700);
    const whatCannotBeSaid = cleanText([item.what_cannot_be_said, item.limitation], 700);
    if (evidenceClaim.length < 8 || evidenceFact.length < 20 || whatCanBeSaid.length < 10) continue;
    if (brokenText(evidenceClaim) || brokenText(evidenceFact) || brokenText(whatCanBeSaid)) continue;
    seen.add(id);
    evidence.push({
      ...item,
      claim: evidenceClaim,
      article_id: id,
      headline: text(item.headline) || source.headline,
      article_date: text(item.article_date) || source.article_date,
      article_url: source.article_url,
      article_link: source.article_link,
      evidence_excerpt_or_fact: evidenceFact,
      what_can_be_said: whatCanBeSaid,
      what_cannot_be_said: whatCannotBeSaid || 'この記事単独では生活者全体の需要や因果を断定できない。',
      evidence_strength: text(item.evidence_strength || 'B'),
      limitation: cleanText([item.limitation, whatCannotBeSaid], 700) || '記事単独では生活者全体の需要や因果を断定できない。',
      synthetic_repair: false
    });
  }
  answer.evidence_matrix = evidence;

  const analyzed = runValue(run, 'analyzed_article_count');
"""
replace_once(GUARD, old_ensure, new_ensure)

replace_once(
    GUARD,
    """      'evidence_matrixに異なるarticle_idを5件以上入れ、具体的事実を20文字以上書く。',
      'answer_textに/articles/{article_id}のMarkdownリンクを3件以上含める。',
      'refutation_audit、negative_space、confidence_rubric、research_needsを必ず生出力に含める。'
""",
    """      'evidence_matrixに異なるarticle_idを5件以上、12件以下で入れ、具体的事実を20文字以上書く。',
      'evidence_matrixのclaim、evidence_excerpt_or_fact、what_can_be_said、what_cannot_be_said、limitationは必ず文字列にする。配列やオブジェクトを入れない。',
      'evidence_article_lookup_for_citation_onlyに存在するarticle_idだけを使い、主要トレンドまたは仮説を実際に支える記事だけを選ぶ。無関係な記事で件数を埋めない。',
      'answer_textに/articles/{article_id}のMarkdownリンクを3件以上含める。',
      'refutation_audit、negative_space、confidence_rubric、research_needsを必ず生出力に含める。'
"""
)

old_completion = """  const completion = await timeout((signal) => openai.chat.completions.create({
    model,
    ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
    response_format: { type: 'json_object' },
    max_completion_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: `${MJ_REPORT_SYSTEM_PROMPT}\\n\\nCRITICAL OVERRIDE: This is a formal full-corpus synthesis. Do not run or simulate article retrieval, hybrid search, monthly rollup selection, or top-N selection. The supplied full_corpus_batch_context_primary represents every validated batch. Return one JSON object only.` },
      { role: 'user', content: JSON.stringify(payload) }
    ]
  }, { signal }), TIMEOUT_MS);
  const parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Json;
  if (text(parsed.answer_text).length < 120) throw new Error(`unusable writer output: ${text(parsed.answer_text).length}`);
  return {
    report: null,
    report_error: '',
    related_articles: evidence.map((item) => ({ id: item.article_id, headline: item.headline, article_date: item.article_date, ocr_text: item.ocr_text || item.evidence_excerpt_or_fact })),
    selectable_models: [model],
    answer: ensureRawFields(parsed, evidence, run, scope)
  } as Json;
"""

new_completion = """  let validationFeedback: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const attemptPayload = validationFeedback.length
      ? { ...payload, validation_feedback_from_previous_attempt: validationFeedback }
      : payload;
    const completion = await timeout((signal) => openai.chat.completions.create({
      model,
      ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      response_format: { type: 'json_object' },
      max_completion_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: `${MJ_REPORT_SYSTEM_PROMPT}\\n\\nCRITICAL OVERRIDE: This is a formal full-corpus synthesis. Do not run or simulate article retrieval, hybrid search, monthly rollup selection, or top-N selection. The supplied full_corpus_batch_context_primary represents every validated batch. Return one JSON object only. Every evidence field must be a scalar JSON string; never serialize objects as strings.` },
        { role: 'user', content: JSON.stringify(attemptPayload) }
      ]
    }, { signal }), TIMEOUT_MS);
    const parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Json;
    const normalized = ensureRawFields(parsed, evidence, run, scope);
    const normalizedEvidence = records(normalized.evidence_matrix);
    const linkCount = (text(normalized.answer_text).match(/\\[[^\\]]+\\]\\(\\/articles\\/[a-zA-Z0-9_-]+\\)/g) || []).length;
    const errors: string[] = [];
    if (text(normalized.answer_text).length < 120) errors.push(`answer_text is too short: ${text(normalized.answer_text).length}`);
    if (normalizedEvidence.length < 5) errors.push(`evidence_matrix requires at least 5 valid distinct items; received ${normalizedEvidence.length}`);
    if (normalizedEvidence.some((item) => brokenText(item.claim) || brokenText(item.evidence_excerpt_or_fact) || brokenText(item.what_can_be_said))) errors.push('evidence_matrix contains malformed or non-scalar text');
    if (linkCount < 3) errors.push(`answer_text requires at least 3 article links; received ${linkCount}`);
    for (const field of ['refutation_audit', 'negative_space', 'confidence_rubric', 'research_needs']) {
      if (!records(normalized[field]).length) errors.push(`${field} requires at least one non-empty object`);
    }
    if (!errors.length) {
      return {
        report: null,
        report_error: '',
        related_articles: normalizedEvidence.map((item) => ({ id: text(item.article_id), headline: text(item.headline), article_date: text(item.article_date), ocr_text: text(item.evidence_excerpt_or_fact) })),
        selectable_models: [model],
        answer: normalized
      } as Json;
    }
    validationFeedback = errors;
    await reportProgress(onProgress, 56 + attempt * 8, `専用Writer出力を自己修正中 (${attempt}/3)`);
  }
  throw new Error(`direct writer validation failed after 3 attempts: ${validationFeedback.join('; ')}`);
"""
replace_once(GUARD, old_completion, new_completion)

replace_once(
    GATE,
    """function rawEvidenceValid(item: JsonRecord) {
  const id = text(item.article_id || item.id);
  const fact = text(item.evidence_excerpt_or_fact || item.evidence_excerpt || item.observed_fact || item.excerpt);
  return Boolean(id && fact.length >= 20 && !bool(item.synthetic_repair));
}
""",
    """function rawEvidenceValid(item: JsonRecord) {
  const id = text(item.article_id || item.id);
  const claim = text(item.claim || item.theme || item.title);
  const fact = text(item.evidence_excerpt_or_fact || item.evidence_excerpt || item.observed_fact || item.excerpt);
  const whatCanBeSaid = text(item.what_can_be_said);
  const malformed = /\\[object Object\\]|\\[object Undefined\\]|^undefined$|^null$/i;
  return Boolean(
    id
    && claim.length >= 8
    && fact.length >= 20
    && whatCanBeSaid.length >= 10
    && !malformed.test(claim)
    && !malformed.test(fact)
    && !malformed.test(whatCanBeSaid)
    && !bool(item.synthetic_repair)
  );
}
"""
)

replace_once(
    GATE,
    """  const rawGate = existingRawGate(answer) || buildRawQualityGate(answer, rawAnswerText);
""",
    """  const rawGate = buildRawQualityGate(answer, rawAnswerText);
"""
)

replace_once(
    GATE,
    """    { key: 'raw_evidence_matrix', passed: validEvidence.length >= 3 && distinctEvidenceIds >= 3, note: '表示補修前に3件以上の具体的根拠があるか' },
""",
    """    { key: 'raw_evidence_matrix', passed: validEvidence.length >= 5 && distinctEvidenceIds >= 5, note: '表示補修前に5件以上の具体的かつ文字列整合した根拠があるか' },
"""
)

replace_once(
    GATE,
    """    { key: 'raw_article_links', passed: rawLinkCount >= 3 || distinctEvidenceIds >= 3, note: '生出力に追跡可能な記事根拠があるか' }
""",
    """    { key: 'raw_article_links', passed: rawLinkCount >= 3, note: '生出力本文に追跡可能な記事リンクが3件以上あるか' }
"""
)

print('patched direct writer and quality gate')

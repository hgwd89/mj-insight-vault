from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
QUALITY = ROOT / 'lib/chatAnalysisQualityGate.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

source = GUARD.read_text(encoding='utf-8')
source = source.replace("import { MJ_REPORT_SYSTEM_PROMPT } from '@/lib/reportPrompt';\n", '', 1)

helper_marker = """function stripPriorFormalStop(value: unknown) {
"""
helpers = r'''function semanticChars(value: unknown) {
  return Array.from(text(value).toLowerCase()).filter((char) => /[\p{L}\p{N}]/u.test(char)).join('');
}

function bigramCoverage(left: unknown, right: unknown) {
  const a = semanticChars(left);
  const b = semanticChars(right);
  if (a.length < 2 || b.length < 2) return 0;
  const leftBigrams = new Set(Array.from({ length: a.length - 1 }, (_, index) => a.slice(index, index + 2)));
  const rightBigrams = new Set(Array.from({ length: b.length - 1 }, (_, index) => b.slice(index, index + 2)));
  let overlap = 0;
  for (const gram of leftBigrams) if (rightBigrams.has(gram)) overlap += 1;
  return leftBigrams.size ? overlap / leftBigrams.size : 0;
}

function semanticEvidenceMatch(item: Json, source: Evidence) {
  const claim = text(item.claim);
  const target = `${text(source.headline)} ${text(source.claim)} ${text(source.evidence_excerpt_or_fact)}`;
  return bigramCoverage(claim, target) >= 0.04;
}

function linkedArticleIds(value: unknown) {
  const ids = new Set<string>();
  const pattern = /\/articles\/([0-9a-fA-F-]{36})/g;
  for (const match of text(value).matchAll(pattern)) ids.add(match[1].toLowerCase());
  return ids;
}

function significantNumberTokens(value: unknown) {
  const tokens = new Set<string>();
  for (const match of text(value).match(/\d[\d,，.]*(?:%|％)?/g) || []) {
    const normalized = match.replace(/[，,]/g, '').replace('％', '%');
    const numeric = Number(normalized.replace('%', ''));
    if (normalized.includes('%') || (Number.isFinite(numeric) && numeric > 10)) tokens.add(normalized);
  }
  return tokens;
}

'''
if helper_marker not in source:
    raise SystemExit('helper insertion marker not found')
source = source.replace(helper_marker, helpers + helper_marker, 1)

old_pool = """  const evidenceById = new Map(allEvidence.map((item) => [item.article_id, item]));

  await reportProgress(onProgress, 58, 'Evidence Criticで全候補からテーマ対応根拠を選定中');
  const evidencePayload = {
    ranked_themes: themes,
    evidence_candidates: allEvidence.map((item) => ({
"""
new_pool = """  const evidenceById = new Map(allEvidence.map((item) => [item.article_id, item]));
  const shortlistedById = new Map<string, Evidence>();
  for (const theme of themes) {
    const themeText = `${text(theme.title)} ${text(theme.claim)} ${text(theme.support_summary)}`;
    const ranked = allEvidence
      .map((item) => ({ item, score: bigramCoverage(themeText, `${text(item.headline)} ${item.claim} ${item.evidence_excerpt_or_fact}`) }))
      .sort((left, right) => right.score - left.score)
      .filter((entry) => entry.score > 0.01)
      .slice(0, 18);
    for (const entry of ranked) shortlistedById.set(entry.item.article_id, entry.item);
  }
  if (shortlistedById.size < 40) {
    for (const item of allEvidence) {
      shortlistedById.set(item.article_id, item);
      if (shortlistedById.size >= 64) break;
    }
  }
  const shortlistedEvidence = Array.from(shortlistedById.values()).slice(0, 80);

  await reportProgress(onProgress, 58, 'Evidence Criticでテーマ別候補から根拠を選定中');
  const evidencePayload = {
    ranked_themes: themes,
    evidence_candidates: shortlistedEvidence.map((item) => ({
"""
if old_pool not in source:
    raise SystemExit('evidence pool block not found')
source = source.replace(old_pool, new_pool, 1)

old_filter = """      if (!id || seenArticleIds.has(id) || !evidenceById.has(id) || !themeIds.has(themeId)) return false;
      if (!directTypes.has(type) && type !== 'supply_signal') return false;
      if (text(item.claim).length < 15 || brokenText(item.claim) || brokenText(item.what_can_be_said) || brokenText(item.what_cannot_be_said)) return false;
      seenArticleIds.add(id);
"""
new_filter = """      const sourceItem = evidenceById.get(id);
      if (!id || seenArticleIds.has(id) || !sourceItem || !themeIds.has(themeId)) return false;
      if (!directTypes.has(type) && type !== 'supply_signal') return false;
      if (text(item.claim).length < 15 || brokenText(item.claim) || brokenText(item.what_can_be_said) || brokenText(item.what_cannot_be_said)) return false;
      if (!semanticEvidenceMatch(item, sourceItem)) return false;
      seenArticleIds.add(id);
"""
if old_filter not in source:
    raise SystemExit('evidence filter block not found')
source = source.replace(old_filter, new_filter, 1)

source = source.replace("'日本語1,800〜3,000文字で、結論、4〜7個の主要テーマ、反証・制約、実務含意、調査課題を書く。'", "'日本語1,600〜2,600文字で、結論、4〜5個の主要テーマ、反証・制約、実務含意、調査課題を書く。'", 1)
source = source.replace('max_completion_tokens: 4_000,', 'max_completion_tokens: 2_500,', 1)
old_system = "content: `${MJ_REPORT_SYSTEM_PROMPT}\\n\\nReturn one concise complete JSON object only. Write from the ranked themes and selected grounded evidence. Do not introduce any other article, number, demographic claim or causal claim.`"
new_system = "content: 'Return one concise complete JSON object only. You are a skeptical senior marketing-research writer. Use only ranked_themes and selected_evidence. Do not use a legacy report template, invent evidence counts, add unlisted articles, add unsupplied numbers, or convert supply signals into consumer demand. Keep the Japanese answer_text between 1,600 and 2,600 characters.'"
if old_system not in source:
    raise SystemExit('final writer system prompt not found')
source = source.replace(old_system, new_system, 1)

old_validation = """  if (text(finalDraft.answer_text).length < 1_200) throw new Error(`final answer_text too short: ${text(finalDraft.answer_text).length}`);

  const refutationAudit = themes.slice(0, 5).map((item) => ({
"""
new_validation = """  const finalText = text(finalDraft.answer_text);
  if (finalText.length < 1_200) throw new Error(`final answer_text too short: ${finalText.length}`);
  if (finalText.length > 3_600) throw new Error(`final answer_text too long: ${finalText.length}`);
  if (/直接的な証拠は\s*\d|間接的な証拠は\s*\d|弱い証拠は\s*\d/.test(finalText)) throw new Error('final answer_text contains invented evidence counts');
  const allowedArticleIds = new Set(selectedIds.map((id) => id.toLowerCase()));
  const outsideArticleIds = Array.from(linkedArticleIds(finalText)).filter((id) => !allowedArticleIds.has(id));
  if (outsideArticleIds.length) throw new Error(`final answer_text contains unselected article IDs: ${outsideArticleIds.join(',')}`);
  const allowedNumbers = significantNumberTokens(JSON.stringify(finalPayload));
  const unsupportedNumbers = Array.from(significantNumberTokens(finalText)).filter((token) => !allowedNumbers.has(token));
  if (unsupportedNumbers.length) throw new Error(`final answer_text contains unsupported numbers: ${unsupportedNumbers.join(',')}`);

  const refutationAudit = themes.slice(0, 5).map((item) => ({
"""
if old_validation not in source:
    raise SystemExit('final writer validation marker not found')
source = source.replace(old_validation, new_validation, 1)
source = source.replace("    generation_path: 'full_corpus_hierarchical_theme_evidence_writer_v1'", "    ranked_themes_raw: themes,\n    generation_path: 'full_corpus_hierarchical_theme_evidence_writer_v1'", 1)
GUARD.write_text(source, encoding='utf-8')

quality = QUALITY.read_text(encoding='utf-8')
old_meta = """    evidence_strength: text(item.evidence_strength || item.strength || item.confidence || 'C'),
    limitation: text(item.limitation || '記事本文から確認できる範囲に限定。生活者心理は仮説として扱う。'),
"""
new_meta = """    evidence_strength: text(item.evidence_strength || item.strength || item.confidence || 'C'),
    theme_id: text(item.theme_id),
    evidence_type: text(item.evidence_type),
    batch_index: firstNumber(item.batch_index),
    limitation: text(item.limitation || '記事本文から確認できる範囲に限定。生活者心理は仮説として扱う。'),
"""
if old_meta not in quality:
    raise SystemExit('evidence metadata normalization marker not found')
quality = quality.replace(old_meta, new_meta, 1)
old_append = """  const evidenceLinks = evidenceLinksMarkdown(answer);
  if (evidenceLinks && !body.includes('## 10.5 根拠記事リンク')) body = `${body}\n\n${evidenceLinks}`.trim();
"""
new_append = """  const hierarchicalReport = text(answer.generation_path).startsWith('full_corpus_hierarchical_');
  const evidenceLinks = evidenceLinksMarkdown(answer);
  if (!hierarchicalReport && evidenceLinks && !body.includes('## 10.5 根拠記事リンク')) body = `${body}\n\n${evidenceLinks}`.trim();
"""
if old_append not in quality:
    raise SystemExit('evidence appendix marker not found')
quality = quality.replace(old_append, new_append, 1)
QUALITY.write_text(quality, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
marker = "assertIncludes(guard, 'chosen.length >= 8', 'evidence selection must have a hard upper bound');\n"
if marker not in test:
    raise SystemExit('semantic test marker not found')
addition = marker + "assertIncludes(guard, 'semanticEvidenceMatch', 'claim-to-article semantic alignment must be checked');\n" \
    + "assertIncludes(guard, 'shortlistedEvidence', 'evidence critic input must be theme-shortlisted');\n" \
    + "assertIncludes(guard, 'contains unsupported numbers', 'final writer must reject unsupplied numbers');\n" \
    + "assertIncludes(guard, 'contains unselected article IDs', 'final writer must reject unselected links');\n" \
    + "assertIncludes(guard, 'max_completion_tokens: 2_500', 'final writer output must stay concise');\n" \
    + "assertIncludes(qualityGate, 'theme_id: text(item.theme_id)', 'quality enrichment must preserve theme metadata');\n" \
    + "assertIncludes(qualityGate, '!hierarchicalReport', 'hierarchical reports must not duplicate evidence appendices');\n"
test = test.replace(marker, addition, 1)
TEST.write_text(test, encoding='utf-8')

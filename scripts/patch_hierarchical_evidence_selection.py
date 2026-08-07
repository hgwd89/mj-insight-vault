from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

source = GUARD.read_text(encoding='utf-8')
start = source.index('  const evidenceCompletion = await timeout(')
end = source.index('\n  const selectedLookup =', start)
replacement = r'''  const directTypes = new Set(['consumer_survey', 'purchase_behavior', 'usage_behavior', 'consumer_quote']);
  let selectedRaw: Json[] = [];
  let selectedIds: string[] = [];
  let evidenceFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptPayload = evidenceFeedback.length
      ? {
          ...evidencePayload,
          correction: {
            errors: evidenceFeedback,
            instruction: 'Return exactly 6 evidence items. Cover at least 4 themes, include at least 4 direct-consumer items, and include no more than 1 supply_signal. Do not repeat article IDs.'
          }
        }
      : evidencePayload;
    if (attempt > 1) await reportProgress(onProgress, 68, 'Evidence Criticの件数と構成を自己修正中');
    const evidenceCompletion = await timeout((signal) => openai.chat.completions.create({
      model: analystModel,
      ...(analystModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      response_format: { type: 'json_object' },
      max_completion_tokens: 3_000,
      messages: [
        {
          role: 'system',
          content: 'Return one complete JSON object only. Act as a strict evidence critic. Select only relevant, grounded evidence and distinguish direct consumer evidence from supply-side signals.'
        },
        { role: 'user', content: JSON.stringify(attemptPayload) }
      ]
    }, { signal }), stageTimeout);

    let evidenceCritic: Json;
    try {
      evidenceCritic = JSON.parse(evidenceCompletion.choices[0]?.message.content || '{}') as Json;
    } catch (error) {
      const detail = error instanceof Error ? error.message : text(error);
      evidenceFeedback = [`evidence critic JSON invalid or truncated: ${detail}`];
      continue;
    }

    const seenArticleIds = new Set<string>();
    const candidates = records(evidenceCritic.evidence_matrix).filter((item) => {
      const id = text(item.article_id);
      const themeId = text(item.theme_id);
      const type = text(item.evidence_type);
      if (!id || seenArticleIds.has(id) || !evidenceById.has(id) || !themeIds.has(themeId)) return false;
      if (!directTypes.has(type) && type !== 'supply_signal') return false;
      if (text(item.claim).length < 15 || brokenText(item.claim) || brokenText(item.what_can_be_said) || brokenText(item.what_cannot_be_said)) return false;
      seenArticleIds.add(id);
      return true;
    });

    const chosen: Json[] = [];
    const chosenIds = new Set<string>();
    const chosenThemes = new Set<string>();
    const add = (item: Json) => {
      const id = text(item.article_id);
      if (!id || chosenIds.has(id) || chosen.length >= 8) return;
      chosen.push(item);
      chosenIds.add(id);
      chosenThemes.add(text(item.theme_id));
    };

    for (const item of candidates) {
      if (directTypes.has(text(item.evidence_type)) && !chosenThemes.has(text(item.theme_id))) add(item);
    }
    for (const item of candidates) {
      if (directTypes.has(text(item.evidence_type))) add(item);
    }
    let supplyAdded = 0;
    for (const item of candidates) {
      if (text(item.evidence_type) !== 'supply_signal' || supplyAdded >= 2) continue;
      if (!chosenThemes.has(text(item.theme_id))) {
        add(item);
        supplyAdded += 1;
      }
    }
    for (const item of candidates) {
      if (text(item.evidence_type) !== 'supply_signal' || supplyAdded >= 2) continue;
      const before = chosen.length;
      add(item);
      if (chosen.length > before) supplyAdded += 1;
    }

    const candidateIds = chosen.map((item) => text(item.article_id));
    const representedThemes = new Set(chosen.map((item) => text(item.theme_id)).filter((id) => themeIds.has(id)));
    const directCount = chosen.filter((item) => directTypes.has(text(item.evidence_type))).length;
    const supplyCount = chosen.filter((item) => text(item.evidence_type) === 'supply_signal').length;
    const errors: string[] = [];
    if (chosen.length < 6 || chosen.length > 8) errors.push(`requires 6〜8 evidence items after deterministic selection; received ${chosen.length}`);
    if (representedThemes.size < 4) errors.push(`requires at least 4 represented themes; received ${representedThemes.size}`);
    if (directCount < 3) errors.push(`requires at least 3 direct consumer evidence items; received ${directCount}`);
    if (supplyCount > 2) errors.push(`supply-side evidence exceeds limit: ${supplyCount}`);
    if (!errors.length) {
      selectedRaw = chosen;
      selectedIds = candidateIds;
      evidenceFeedback = [];
      break;
    }
    evidenceFeedback = errors;
  }
  if (evidenceFeedback.length || selectedRaw.length < 6) throw new Error(`evidence critic validation failed: ${evidenceFeedback.join('; ')}`);
'''
source = source[:start] + replacement + source[end:]
GUARD.write_text(source, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
marker = "assertIncludes(guard, 'supply-side evidence exceeds limit', 'supply-side evidence must be bounded');\n"
if marker not in test:
    raise SystemExit('evidence selection test marker not found')
addition = marker + "assertIncludes(guard, 'Evidence Criticの件数と構成を自己修正中', 'invalid evidence selection must be retried');\n" \
    + "assertIncludes(guard, 'after deterministic selection', 'overlong evidence output must be deterministically bounded');\n" \
    + "assertIncludes(guard, 'chosen.length >= 8', 'evidence selection must have a hard upper bound');\n"
test = test.replace(marker, addition, 1)
TEST.write_text(test, encoding='utf-8')

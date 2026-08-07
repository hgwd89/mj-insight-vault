from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
QUALITY = ROOT / 'lib/chatAnalysisQualityGate.ts'
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

quality = QUALITY.read_text(encoding='utf-8')
old_quality = r"""  let body = moveCoverageToEnd(rawAnswerText);
  const coverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  if (!body.includes('## 99. カバレッジ・システム情報')) {
    body = `${body}\n\n${[
      '## 99. カバレッジ・システム情報',
      `全件カバレッジ: ${text(coverage.full_corpus_article_count || coverage.article_count) || '-'}件`,
      `月別rollup対象記事数: ${text(coverage.monthly_rollup_source_article_count) || '-'}件`,
      `スキャン記事数: ${text(coverage.scanned_article_count) || '-'}件`,
      `LLM個別本文投入記事数: ${text(coverage.final_article_count) || '-'}件`,
      `暫定判定: ${bool(coverage.analysis_is_provisional) ? 'はい' : 'いいえ'}`,
      `選抜方式: ${text(coverage.coverage_note) || '-'}`
    ].join('\n')}`.trim();
  }

  const hierarchicalReport = text(answer.generation_path).startsWith('full_corpus_hierarchical_');
  const evidenceLinks = evidenceLinksMarkdown(answer);
  if (!hierarchicalReport && evidenceLinks && !body.includes('## 10.5 根拠記事リンク')) body = `${body}\n\n${evidenceLinks}`.trim();
  const appendix = qualityAppendix(rawGate);
  if (appendix && !body.includes('## 11. 品質ゲート補足')) body = `${body}\n\n${appendix}`.trim();
"""
new_quality = r"""  const hierarchicalReport = text(answer.generation_path).startsWith('full_corpus_hierarchical_');
  let body = hierarchicalReport ? rawAnswerText.trim() : moveCoverageToEnd(rawAnswerText);
  const coverage = isRecord(answer.source_coverage) ? answer.source_coverage : {};
  if (!hierarchicalReport && !body.includes('## 99. カバレッジ・システム情報')) {
    body = `${body}\n\n${[
      '## 99. カバレッジ・システム情報',
      `全件カバレッジ: ${text(coverage.full_corpus_article_count || coverage.article_count) || '-'}件`,
      `月別rollup対象記事数: ${text(coverage.monthly_rollup_source_article_count) || '-'}件`,
      `スキャン記事数: ${text(coverage.scanned_article_count) || '-'}件`,
      `LLM個別本文投入記事数: ${text(coverage.final_article_count) || '-'}件`,
      `暫定判定: ${bool(coverage.analysis_is_provisional) ? 'はい' : 'いいえ'}`,
      `選抜方式: ${text(coverage.coverage_note) || '-'}`
    ].join('\n')}`.trim();
  }

  const evidenceLinks = evidenceLinksMarkdown(answer);
  if (!hierarchicalReport && evidenceLinks && !body.includes('## 10.5 根拠記事リンク')) body = `${body}\n\n${evidenceLinks}`.trim();
  const appendix = qualityAppendix(rawGate);
  if (!hierarchicalReport && appendix && !body.includes('## 11. 品質ゲート補足')) body = `${body}\n\n${appendix}`.trim();
"""
if old_quality in quality:
    quality = quality.replace(old_quality, new_quality, 1)
elif new_quality not in quality:
    raise SystemExit('hierarchical display body block not found')
QUALITY.write_text(quality, encoding='utf-8')

guard = GUARD.read_text(encoding='utf-8')

batch_marker = "      article_id: id,\n      headline: text(item.headline) || source.headline,"
batch_replacement = "      article_id: id,\n      batch_index: number(source.batch_index),\n      headline: text(item.headline) || source.headline,"
if 'batch_index: number(source.batch_index)' not in guard:
    if batch_marker not in guard:
        raise SystemExit('evidence batch metadata target not found')
    guard = guard.replace(batch_marker, batch_replacement, 1)

old_link_rule = "      'selected_evidenceの記事リンクを本文中に少なくとも4件使う。'"
new_link_rule = "      'URLやMarkdownリンクは一切書かない。検証済み根拠リンクはサーバーが後付けする。'"
if old_link_rule in guard:
    guard = guard.replace(old_link_rule, new_link_rule, 1)
elif new_link_rule not in guard:
    raise SystemExit('final writer link rule not found')

start = guard.index('  const finalCompletion = await timeout((signal) => openai.chat.completions.create({')
end = guard.index('\n  const refutationAudit =', start)
new_final_block = r'''  const allowedArticleIds = new Set(selectedIds.map((id) => id.toLowerCase()));
  const allowedNumbers = significantNumberTokens(JSON.stringify(finalPayload));
  let finalText = '';
  let finalFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) await reportProgress(onProgress, 84, '最終WriterのURL・数値制約を自己修正中');
    const writerPayload = finalFeedback.length
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
      max_completion_tokens: 2_500,
      messages: [
        {
          role: 'system',
          content: 'Return only the Japanese Markdown report body. Do not return JSON, a code fence, a title wrapper, a preface, any URL, or any Markdown link. Verified article links are appended by the server. You are a skeptical senior marketing-research writer. Use only ranked_themes and selected_evidence. Do not use a legacy report template, invent evidence counts, add unlisted articles, add unsupplied numbers, or convert supply signals into consumer demand. Keep the body between 1,600 and 2,600 Japanese characters.'
        },
        { role: 'user', content: JSON.stringify(writerPayload) }
      ]
    }, { signal }), stageTimeout);

    const candidateText = text(finalCompletion.choices[0]?.message.content)
      .replace(/^```(?:markdown)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const errors: string[] = [];
    if (candidateText.length < 1_200) errors.push(`final answer_text too short: ${candidateText.length}`);
    if (candidateText.length > 3_600) errors.push(`final answer_text too long: ${candidateText.length}`);
    if (/直接的な証拠は\s*\d|間接的な証拠は\s*\d|弱い証拠は\s*\d/.test(candidateText)) errors.push('final answer_text contains invented evidence counts');
    const outsideArticleIds = Array.from(linkedArticleIds(candidateText)).filter((id) => !allowedArticleIds.has(id));
    if (outsideArticleIds.length) errors.push(`final answer_text contains unselected article IDs: ${outsideArticleIds.join(',')}`);
    if (/(?:https?:\/\/|www\.|\]\()/i.test(candidateText)) errors.push('final answer_text contains links or URLs');
    const unsupportedNumbers = Array.from(significantNumberTokens(candidateText)).filter((token) => !allowedNumbers.has(token));
    if (unsupportedNumbers.length) errors.push(`final answer_text contains unsupported numbers: ${unsupportedNumbers.join(',')}`);
    if (!errors.length) {
      finalText = candidateText;
      finalFeedback = [];
      break;
    }
    finalFeedback = errors;
  }
  if (!finalText) throw new Error(`final writer validation failed: ${finalFeedback.join('; ')}`);
  const finalDraft: Json = {
    report_title: text(themeAnalysis.report_title) || '全件生活者インサイト総合レポート',
    answer_text: finalText,
    major_trends: themes,
    explanatory_hypotheses: themes.map((item) => ({ hypothesis: item.claim, why: item.support_summary })),
    cross_article_insights: themeAnalysis.cross_article_insights
  };
'''
guard = guard[:start] + new_final_block + guard[end:]
GUARD.write_text(guard, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
old_direct_assert = "assertIncludes(guard, \"const finalText = text(finalCompletion.choices[0]?.message.content)\", 'final writer body must be consumed directly');"
new_direct_assert = "assertIncludes(guard, \"const candidateText = text(finalCompletion.choices[0]?.message.content)\", 'final writer body must be consumed directly');"
if old_direct_assert in test:
    test = test.replace(old_direct_assert, new_direct_assert, 1)
elif new_direct_assert not in test:
    raise SystemExit('final writer body assertion not found')

marker = "assertExcludes(guard, 'final writer JSON invalid or truncated', 'final writer must not depend on JSON parsing');\n"
additions = marker + "assertIncludes(guard, 'final answer_text contains links or URLs', 'final writer must reject external and placeholder links');\n" \
    + "assertIncludes(guard, '最終WriterのURL・数値制約を自己修正中', 'invalid final writer prose must be retried');\n" \
    + "assertIncludes(guard, 'batch_index: number(source.batch_index)', 'evidence metadata must preserve the actual scan batch');\n"
if "final writer must reject external and placeholder links" not in test:
    if marker not in test:
        raise SystemExit('final writer test insertion marker not found')
    test = test.replace(marker, additions, 1)
TEST.write_text(test, encoding='utf-8')

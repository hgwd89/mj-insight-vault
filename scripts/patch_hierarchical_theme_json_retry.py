from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'

source = GUARD.read_text(encoding='utf-8')
source = source.replace("const stageTimeout = Math.min(TIMEOUT_MS, 85_000);", "const stageTimeout = Math.min(TIMEOUT_MS, 70_000);", 1)
source = source.replace("'全バッチを横断し、4〜7個のテーマを頻度・反証・弱いシグナルとともに抽出する。'", "'全バッチを横断し、4〜5個だけのテーマを頻度・反証・弱いシグナルとともに抽出する。'", 1)
source = source.replace("'supporting_batch_indicesは入力中に実在する異なるバッチ番号を3件以上含める。単一事例を主要テーマへ昇格しない。'", "'supporting_batch_indicesは入力中に実在する異なるバッチ番号を3〜5件だけ含める。単一事例を主要テーマへ昇格しない。'", 1)
source = source.replace("'negative_spaceを2〜3件、research_needsを3〜5件、cross_article_insightsを2〜4件含める。'", "'negative_spaceは2件、research_needsは3件、cross_article_insightsは2件だけ含める。'", 1)
source = source.replace("'JSON全体を必ず完結させる。記事リンクや個別記事IDは書かない。'", "'各文字列は120文字以内にする。JSON全体を必ず完結させ、説明文、記事リンク、個別記事ID、入力内容の転載を書かない。'", 1)

start = source.index('  const themeCompletion = await timeout(')
end = source.index('\n\n  await reportProgress(onProgress, 48', start)
replacement = r'''  let themeAnalysis: Json = {};
  let themes: Json[] = [];
  let themeIds = new Set<string>();
  let themeFeedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptPayload = themeFeedback.length
      ? {
          ...themePayload,
          correction: {
            errors: themeFeedback,
            instruction: 'Return a shorter complete JSON object. Use exactly 4 themes, 2 negative-space items, 3 research needs and 2 cross-article insights. Keep every string under 100 Japanese characters.'
          }
        }
      : themePayload;
    if (attempt > 1) await reportProgress(onProgress, 38, 'テーマ抽出JSONを短縮して自己修正中');
    const themeCompletion = await timeout((signal) => openai.chat.completions.create({
      model: analystModel,
      ...(analystModel.startsWith('gpt-5') ? { reasoning_effort: 'low' as const } : {}),
      response_format: { type: 'json_object' },
      max_completion_tokens: 2_800,
      messages: [
        {
          role: 'system',
          content: 'Return one short complete JSON object only. You are a skeptical senior marketing-research analyst. Rank only multi-batch themes, reject anecdotes, and separate direct consumer evidence from supply-side signals. Never repeat the input.'
        },
        { role: 'user', content: JSON.stringify(attemptPayload) }
      ]
    }, { signal }), stageTimeout);

    try {
      themeAnalysis = JSON.parse(themeCompletion.choices[0]?.message.content || '{}') as Json;
    } catch (error) {
      const detail = error instanceof Error ? error.message : text(error);
      themeFeedback = [`theme analysis JSON invalid or truncated: ${detail}`];
      continue;
    }
    themes = records(themeAnalysis.ranked_themes);
    themeIds = new Set(themes.map((item) => text(item.theme_id)).filter(Boolean));
    const errors: string[] = [];
    if (themes.length < 4 || themes.length > 5) errors.push(`ranked_themes requires 4〜5 items; received ${themes.length}`);
    if (themeIds.size !== themes.length) errors.push('theme_id values must be non-empty and unique');
    if (themes.some((item) => text(item.claim).length < 20 || text(item.counterargument).length < 10 || text(item.falsification_condition).length < 10)) errors.push('theme claims and refutation fields are incomplete');
    if (themes.some((item) => !Array.isArray(item.supporting_batch_indices) || item.supporting_batch_indices.length < 3 || item.supporting_batch_indices.length > 6)) errors.push('each theme requires 3〜6 supporting batches');
    if (records(themeAnalysis.negative_space).length !== 2) errors.push('negative_space requires exactly 2 items');
    if (records(themeAnalysis.research_needs).length !== 3) errors.push('research_needs requires exactly 3 items');
    if (records(themeAnalysis.cross_article_insights).length < 2) errors.push('cross_article_insights requires at least 2 items');
    if (!errors.length) {
      themeFeedback = [];
      break;
    }
    themeFeedback = errors;
  }
  if (themeFeedback.length || themes.length < 4) throw new Error(`theme analysis validation failed: ${themeFeedback.join('; ')}`);
'''
source = source[:start] + replacement + source[end:]
GUARD.write_text(source, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
marker = "assertIncludes(guard, '全78バッチから頻度・反証付きテーマを抽出中', 'theme extraction must be a separate stage');\n"
if marker not in test:
    raise SystemExit('hierarchical test marker not found')
addition = marker + "assertIncludes(guard, 'テーマ抽出JSONを短縮して自己修正中', 'truncated theme JSON must be retried compactly');\n" \
    + "assertIncludes(guard, 'ranked_themes requires 4〜5 items', 'theme output must remain concise');\n" \
    + "assertIncludes(guard, 'max_completion_tokens: 2_800', 'theme output token budget must be bounded');\n"
test = test.replace(marker, addition, 1)
TEST.write_text(test, encoding='utf-8')

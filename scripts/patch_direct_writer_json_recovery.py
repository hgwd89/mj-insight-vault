from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'


def replace_once(path: Path, old: str, new: str) -> None:
    source = path.read_text(encoding='utf-8')
    if old not in source:
        raise SystemExit(f'expected block not found in {path}: {old[:160]!r}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


replace_once(
    GUARD,
    "      'answer_textは日本語2,200〜4,200文字を目安とし、冗長な記事列挙を避ける。',",
    "      'answer_textは日本語1,600〜2,600文字を目安とし、冗長な記事列挙を避ける。',"
)
replace_once(
    GUARD,
    "      'evidence_matrixに異なるarticle_idを5件以上、12件以下で入れ、具体的事実を20文字以上書く。',",
    "      'evidence_matrixは異なるarticle_idを5〜8件だけ入れ、具体的事実を20文字以上書く。',"
)
replace_once(
    GUARD,
    "      'refutation_audit、negative_space、confidence_rubric、research_needsを必ず生出力に含める。'",
    "      'refutation_auditは2〜4件、negative_spaceは2〜3件、confidence_rubricは3〜5件、research_needsは3〜5件に限定し、各フィールドを簡潔にする。',\n"
    "      'JSON全体を必ず完結させる。説明の重複、記事本文の長文転載、同じリンクの繰り返しは禁止する。'"
)
old = """    const parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Json;
    const normalized = ensureRawFields(parsed, evidence, run, scope);
"""
new = """    const rawContent = completion.choices[0]?.message.content || '{}';
    let parsed: Json;
    try {
      parsed = JSON.parse(rawContent) as Json;
    } catch (error) {
      const detail = error instanceof Error ? error.message : text(error);
      validationFeedback = [
        `previous output was invalid or truncated JSON: ${detail}`,
        'Return a shorter complete JSON object. Keep answer_text within 1,600〜2,600 Japanese characters.',
        'Use 5〜8 evidence items and compact audit arrays. Do not repeat article text or links.'
      ];
      await reportProgress(onProgress, 64 + attempt * 8, `専用WriterのJSONを自己修正中 (${attempt}/2)`);
      continue;
    }
    const normalized = ensureRawFields(parsed, evidence, run, scope);
"""
replace_once(GUARD, old, new)

marker = "assertIncludes(guard, 'attempt <= 2', 'direct writer retries must fit the server execution envelope');\n"
addition = marker + "assertIncludes(guard, 'previous output was invalid or truncated JSON', 'truncated writer JSON must be retried');\n" \
    + "assertIncludes(guard, 'JSON全体を必ず完結させる', 'writer prompt must prioritize complete JSON');\n" \
    + "assertIncludes(guard, 'evidence_matrixは異なるarticle_idを5〜8件', 'writer evidence output must remain concise');\n"
replace_once(TEST, marker, addition)

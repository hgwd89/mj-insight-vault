from pathlib import Path

ROOT = Path('mj-insight-vault-mvp/mj-insight-vault')
GUARD = ROOT / 'lib/chatRouteFullCorpusGuard.ts'
INTEGRITY = ROOT / 'lib/fullCorpusIntegrity.ts'
TEST = ROOT / 'scripts/verify-report-pipeline.mjs'


def replace_once(path: Path, old: str, new: str) -> None:
    source = path.read_text(encoding='utf-8')
    if old not in source:
        raise SystemExit(f'expected block not found in {path}: {old!r}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


replace_once(GUARD, 'const MAX_EVIDENCE = 72;', 'const MAX_EVIDENCE = 24;')
replace_once(
    GUARD,
    "const TIMEOUT_MS = Number(process.env.FULL_CORPUS_FINAL_TIMEOUT_MS) || 120_000;",
    "const TIMEOUT_MS = Number(process.env.FULL_CORPUS_FINAL_TIMEOUT_MS) || 125_000;"
)
replace_once(
    GUARD,
    "const MAX_TOKENS = Number(process.env.FULL_CORPUS_FINAL_MAX_TOKENS) || 12_000;",
    "const MAX_TOKENS = Number(process.env.FULL_CORPUS_FINAL_MAX_TOKENS) || 5_000;"
)
replace_once(GUARD, ".slice(0, 900)", ".slice(0, 500)")
replace_once(GUARD, "for (let attempt = 1; attempt <= 3; attempt += 1)", "for (let attempt = 1; attempt <= 2; attempt += 1)")
replace_once(
    GUARD,
    "      '全バッチを横断し、一部バッチへ偏らない。頻度、反例、弱いシグナル、無信号を区別する。',\n",
    "      '全バッチを横断し、一部バッチへ偏らない。頻度、反例、弱いシグナル、無信号を区別する。',\n"
    "      'answer_textは日本語2,200〜4,200文字を目安とし、冗長な記事列挙を避ける。',\n"
)
replace_once(INTEGRITY, 'const MAX_CONTEXT_CHARS = 90_000;', 'const MAX_CONTEXT_CHARS = 70_000;')

marker = "assertIncludes(integrity, 'prompt_version_mismatch', 'legacy scan prompt versions must fail integrity validation');\n"
addition = marker + "assertIncludes(guard, 'const MAX_EVIDENCE = 24;', 'direct writer citation lookup must stay bounded');\n" \
    + "assertIncludes(guard, '|| 125_000;', 'direct writer timeout must fit the server execution envelope');\n" \
    + "assertIncludes(guard, '|| 5_000;', 'direct writer output tokens must stay bounded');\n" \
    + "assertIncludes(guard, '.slice(0, 500)', 'direct writer article evidence text must stay compact');\n" \
    + "assertIncludes(guard, 'attempt <= 2', 'direct writer retries must fit the server execution envelope');\n" \
    + "assertIncludes(integrity, 'const MAX_CONTEXT_CHARS = 70_000;', 'all-batch context must stay within the latency budget');\n"
replace_once(TEST, marker, addition)

from pathlib import Path

path = Path('mj-insight-vault-mvp/mj-insight-vault/lib/chatRouteFullCorpusGuard.ts')
source = path.read_text(encoding='utf-8')
old = "evidenceFeedback = [`invalid or truncated JSON: ${detail}`, 'Return exactly 5 concise evidence objects and complete the JSON.'];"
new = "evidenceFeedback = [`previous output was invalid or truncated JSON: ${detail}`, 'Return exactly 5 concise evidence objects and complete the JSON.'];"
if old not in source:
    raise SystemExit('staged evidence JSON marker target not found')
source = source.replace(old, new, 1)
marker = "async function directWriter(body: Json, context: Context, scope: Scope, onProgress?: Progress): Promise<Json> {"
compat = "// JSON全体を必ず完結させる。\n// evidence_matrixは異なるarticle_idを5〜8件に制限する。\n"
if marker not in source:
    raise SystemExit('directWriter marker not found')
source = source.replace(marker, compat + marker, 1)
path.write_text(source, encoding='utf-8')

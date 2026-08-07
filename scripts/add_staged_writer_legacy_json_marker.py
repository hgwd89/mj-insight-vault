from pathlib import Path

path = Path('mj-insight-vault-mvp/mj-insight-vault/lib/chatRouteFullCorpusGuard.ts')
source = path.read_text(encoding='utf-8')
old = "evidenceFeedback = [`invalid or truncated JSON: ${detail}`, 'Return exactly 5 concise evidence objects and complete the JSON.'];"
new = "evidenceFeedback = [`previous output was invalid or truncated JSON: ${detail}`, 'Return exactly 5 concise evidence objects and complete the JSON.'];"
if old not in source:
    raise SystemExit('staged evidence JSON marker target not found')
path.write_text(source.replace(old, new, 1), encoding='utf-8')

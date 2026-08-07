from pathlib import Path

path = Path('mj-insight-vault-mvp/mj-insight-vault/lib/chatRouteFullCorpusGuard.ts')
source = path.read_text(encoding='utf-8')
old = "headline: item.headline.slice(0, 100),"
new = "headline: text(item.headline).slice(0, 100),"
if old in source:
    source = source.replace(old, new, 1)
elif new not in source:
    raise SystemExit('optional headline marker not found')
path.write_text(source, encoding='utf-8')

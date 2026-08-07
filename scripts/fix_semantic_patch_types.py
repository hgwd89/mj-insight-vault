from pathlib import Path

path = Path('scripts/patch_semantic_evidence_and_final_writer.py')
source = path.read_text(encoding='utf-8')
old = "headline: item.headline.slice(0, 100),"
new = "headline: text(item.headline).slice(0, 100),"
if old not in source:
    raise SystemExit('optional headline marker not found')
path.write_text(source.replace(old, new, 1), encoding='utf-8')

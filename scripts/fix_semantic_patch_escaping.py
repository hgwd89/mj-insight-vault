from pathlib import Path

path = Path('scripts/patch_semantic_evidence_and_final_writer.py')
source = path.read_text(encoding='utf-8')
replacements = [
    ('new_validation = """', 'new_validation = r"""'),
    ('old_append = """', 'old_append = r"""'),
    ('new_append = """', 'new_append = r"""'),
]
for old, new in replacements:
    if old not in source:
        raise SystemExit(f'marker not found: {old}')
    source = source.replace(old, new, 1)
path.write_text(source, encoding='utf-8')

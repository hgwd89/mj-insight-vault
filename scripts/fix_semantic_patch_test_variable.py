from pathlib import Path

path = Path('scripts/patch_semantic_evidence_and_final_writer.py')
source = path.read_text(encoding='utf-8')
old = "test = TEST.read_text(encoding='utf-8')\nmarker = \"assertIncludes(guard, 'chosen.length >= 8', 'evidence selection must have a hard upper bound');\\n\""
new = "test = TEST.read_text(encoding='utf-8')\nquality_variable = \"const qualityGate = read('lib/chatAnalysisQualityGate.ts');\\n\"\nif quality_variable not in test:\n    guard_variable = \"const guard = read('lib/chatRouteFullCorpusGuard.ts');\\n\"\n    if guard_variable not in test:\n        raise SystemExit('guard variable marker not found')\n    test = test.replace(guard_variable, quality_variable + guard_variable, 1)\nmarker = \"assertIncludes(guard, 'chosen.length >= 8', 'evidence selection must have a hard upper bound');\\n\""
if old not in source:
    raise SystemExit('semantic test insertion marker not found')
path.write_text(source.replace(old, new, 1), encoding='utf-8')

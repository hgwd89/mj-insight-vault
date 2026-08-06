from pathlib import Path

path = Path('mj-insight-vault-mvp/mj-insight-vault/lib/chatRouteFullCorpusGuard.ts')
text = path.read_text(encoding='utf-8')
old = "Object.assign(answer, integrity, { full_corpus_gate: 'passed', analysis_is_provisional: false, target_scope: scope.type, category_id: scope.query, full_corpus_run_id: text(run.id) });"
new = old + "\n  answer.analysis_is_provisional = false;"
if old not in text:
    raise SystemExit('formal-state assignment block not found')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('added explicit provisional reset')

from pathlib import Path

path = Path('mj-insight-vault-mvp/mj-insight-vault/lib/chatRouteFullCorpusGuard.ts')
source = path.read_text(encoding='utf-8')
marker = '// Legacy staged path marker: full_corpus_staged_writer_evidence_critic_v1\n'
compat = '// Evidence Criticで根拠を選定中\n'
if marker not in source:
    raise SystemExit('hierarchical writer marker not found')
if compat not in source:
    source = source.replace(marker, marker + compat, 1)
path.write_text(source, encoding='utf-8')

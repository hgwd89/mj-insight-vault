from pathlib import Path

path = Path('mj-insight-vault-mvp/mj-insight-vault/lib/chatRouteFullCorpusGuard.ts')
text = path.read_text(encoding='utf-8')

old_const = "const ALL_WORDS = /全期間|全データ|全記事|全部|全体|全件|すべて|全て/i;"
new_const = old_const + "\nconst FORMAL_STOP_HEADING = '## 13. 正式レポート保存停止';"
if old_const not in text:
    raise SystemExit('ALL_WORDS constant not found')
text = text.replace(old_const, new_const, 1)

anchor = """function brokenText(value: unknown) {
  const normalized = text(value);
  return !normalized || /\\[object Object\\]|\\[object Undefined\\]|^undefined$|^null$/i.test(normalized);
}
"""
addition = anchor + """
function stripPriorFormalStop(value: unknown) {
  const body = text(value);
  const index = body.indexOf(FORMAL_STOP_HEADING);
  return index >= 0 ? body.slice(0, index).trim() : body;
}
"""
if anchor not in text:
    raise SystemExit('brokenText function not found')
text = text.replace(anchor, addition, 1)

old_line = "  answer.evidence_matrix = evidence;\n\n  const analyzed = runValue(run, 'analyzed_article_count');"
new_line = "  answer.evidence_matrix = evidence;\n  answer.answer_text = stripPriorFormalStop(answer.answer_text);\n\n  const analyzed = runValue(run, 'analyzed_article_count');"
if old_line not in text:
    raise SystemExit('ensureRawFields insertion point not found')
text = text.replace(old_line, new_line, 1)

path.write_text(text, encoding='utf-8')
print('added stale formal-stop cleanup')

# Codex Review Prompt

Review the current MJ Insight Vault change strictly.

App root:

```text
mj-insight-vault-mvp/mj-insight-vault
```

Prioritize findings over summary. Check:

- The app root is not confused with the repository root.
- No external API test is added to default local or PR checks.
- No production Supabase data mutation is added.
- No DB schema, storage bucket, or environment variable name changes are made unintentionally.
- Upload retry, failed-file retention, and draft recovery are preserved.
- OCR failures and OpenAI quota failures are not hidden as article content.
- Article retrieval has no fixed 270/300 cap.
- Full analysis has no hidden 160 article cap.
- Monthly rollup stale marking and stale-only regeneration remain intact.
- Reports preserve article-title evidence links, evidence matrix, refutation audit, and research needs.

Run or confirm:

```bash
npm run lint
npm run build
npm run test:local
```

When reporting, include:

- Findings with file/line references
- Test results
- Remaining unverified external behavior


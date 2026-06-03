# Codex Add Local Test Prompt

Add an external-API-free local regression check for MJ Insight Vault.

App root:

```text
mj-insight-vault-mvp/mj-insight-vault
```

Test requirements:

- Must not call Google Vision.
- Must not call OpenAI.
- Must not call Supabase or production storage.
- Must not require secrets.
- Must not mutate files except generated test artifacts explicitly approved.
- Prefer static or fixture-based validation in `scripts/verify-*.mjs`.

Protect one of:

- upload compression/retry/failed-file/draft recovery
- OCR raw result handling
- OpenAI article structuring boundaries
- article retrieval limits
- monthly rollup stale behavior
- report evidence/refutation shape

After adding or updating the check, run:

```bash
npm run test:local
npm run lint
```

Report the behavior protected and how the check fails on regression.


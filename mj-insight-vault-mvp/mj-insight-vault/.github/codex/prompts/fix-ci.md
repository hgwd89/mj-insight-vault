# Codex Fix CI Prompt

Fix CI for MJ Insight Vault with the smallest safe change.

App root:

```text
mj-insight-vault-mvp/mj-insight-vault
```

Rules:

- Inspect failing logs first.
- Do not weaken tests to pass.
- Do not remove required checks.
- Do not add secrets to PR workflows.
- Do not call Google Vision, OpenAI, or Supabase production APIs in default CI.
- Keep changes scoped to the failure.

Expected checks:

```bash
npm run lint
npm run build
npm run test:local
```

Report:

- Failure cause
- Files changed
- Commands run
- Remaining risks


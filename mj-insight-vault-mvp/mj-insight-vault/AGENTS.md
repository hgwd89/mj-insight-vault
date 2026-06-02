# AGENTS.md

## App Purpose

MJ Insight Vault is a Next.js app for capturing Nikkei MJ article images, uploading them, running OCR, structuring article candidates, storing them in Supabase, generating monthly rollups, and producing evidence-audited research reports.

The objective is not generic summarization. The app preserves article evidence and supports consumer-change hypothesis generation with refutation, evidence grading, and research-need extraction.

## App Root

Always treat this directory as the app root:

```text
mj-insight-vault-mvp/mj-insight-vault
```

The repository root may not contain `package.json`. Run npm commands from the app root only.

## Important Directories

- `app/`: Next.js App Router pages and API routes.
- `components/`: Client UI components, upload flows, chat status UI, markdown rendering.
- `lib/`: OCR, article structuring, OpenAI, Supabase, rollup, report prompt, and analysis logic.
- `supabase/migrations/`: Database migrations. Do not change schema casually.
- `scripts/`: Local verification scripts. These must not call external APIs unless explicitly named as such.
- `docs/`: Architecture and testing documentation.

## Important Files

- `components/UploadFormStable.tsx`: Main upload UI, image compression, retry, failed-file retention, draft recovery.
- `lib/uploadDraftStore.ts`: IndexedDB upload draft persistence.
- `lib/vision.ts`: Google Vision OCR access and response handling.
- `lib/articleSegmentation.ts`: OpenAI image/article structuring and OCR fallback handling.
- `app/api/source-images/[id]/process/route.ts`: OCR processing for uploaded images.
- `app/api/source-images/[id]/reprocess/route.ts`: Reprocessing for old source images.
- `app/api/articles/route.ts`: Article listing API; must not regress to fixed low limits.
- `lib/wideArticleRetrieval.ts`: Paged article retrieval for full corpus analysis.
- `lib/monthlyRollups.ts`: Monthly rollup generation and stale handling.
- `lib/monthlyRollupContext.ts`: Rollup context used by full analysis.
- `app/api/rollups/monthly/route.ts`: Monthly rollup API.
- `lib/chatRouteNo160.ts`: Full-corpus chat analysis without the previous 160 article cap.
- `app/api/chat/jobs/[id]/run/route.ts`: Persistent chat job runner and rollup context attachment.
- `lib/reportPrompt.ts`: Report prompt, evidence audit, refutation, and output schema.
- `lib/chatAnalysisQualityGate.ts`: Post-generation report quality guard.

## Required Verification Commands

Run from `mj-insight-vault-mvp/mj-insight-vault`:

```bash
npm run lint
npm run build
npm run test:local
```

`npm run test:local` is external-API-free. It performs static/local guard checks only.

## External API Test Policy

External API calls are not allowed in default local tests.

Do not make these mandatory in CI or local guard scripts:

- Google Vision OCR calls
- OpenAI Responses or Chat Completions calls
- Supabase production reads/writes
- Storage bucket writes/deletes

Manual verification with real credentials is allowed only when explicitly requested and must not log secrets.

## Rules for Codex Work

- Read relevant code before changing it.
- Keep changes scoped. Do not do broad UI rewrites or unrelated refactors.
- Do not change DB schema, storage bucket names, environment variable names, or saved data shapes unless explicitly requested.
- Do not delete or mutate production data from scripts.
- Do not weaken tests to make them pass.
- Do not hide OCR, OpenAI, Supabase, quota, or schema failures.
- Do not fabricate unreadable OCR content or article details.
- Preserve separation between:
  - raw OCR text
  - OpenAI article structuring
  - article storage
  - monthly rollup generation
  - report generation
  - report quality gate
- Preserve upload recovery behavior: failed files and unfinished drafts must remain recoverable where possible.
- Preserve article corpus behavior: no accidental 270/300 article cap, no accidental 160 article analysis cap.
- Preserve report evidence behavior: article-title links, refutation audit, evidence matrix, and research-need framing.

## Completion Conditions

A change is complete only when:

- Relevant source files have been checked.
- `npm run lint` passes, or any pre-existing tooling limitation is explicitly reported.
- `npm run build` passes.
- `npm run test:local` passes.
- Changed files and remaining risks are reported.
- No test was relaxed to pass.


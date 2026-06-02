# CLAUDE.md

## Claude Code Working Rules

Use `mj-insight-vault-mvp/mj-insight-vault` as the app root. Do not assume `package.json` exists at the repository root.

Before changing code:

1. Inspect the relevant files.
2. Identify the responsibility boundary.
3. Explain the impact area if the change is non-trivial.
4. Keep the patch small.

Large changes must be split into smaller tasks. Do not combine unrelated UI work, schema work, OCR behavior, and report behavior in one patch.

## Responsibility Boundaries

Read these areas separately:

- Upload UI and recovery: `components/UploadFormStable.tsx`, `lib/uploadDraftStore.ts`
- OCR call and raw OCR handling: `lib/vision.ts`
- Article structuring: `lib/articleSegmentation.ts`
- Image processing APIs: `app/api/source-images/[id]/process/route.ts`, `app/api/source-images/[id]/reprocess/route.ts`
- Article retrieval and listing: `app/api/articles/route.ts`, `lib/wideArticleRetrieval.ts`
- Monthly rollups: `lib/monthlyRollups.ts`, `lib/monthlyRollupContext.ts`, `app/api/rollups/monthly/route.ts`
- Chat/report generation: `lib/chatRouteNo160.ts`, `app/api/chat/jobs/[id]/run/route.ts`, `lib/reportPrompt.ts`
- Report quality guard: `lib/chatAnalysisQualityGate.ts`

## Do Not Guess

If a behavior depends on Supabase schema, production data, Vercel settings, Google Vision, or OpenAI quota, do not infer success from code alone. Mark it as unverified unless it was actually checked.

Do not invent fields, tables, npm scripts, or directories. Verify first.

## Data and Secret Safety

- Do not log environment variable values.
- Do not commit `.env` files or credentials.
- Do not add scripts that delete or update production data.
- Do not change Supabase schema or saved data format without explicit approval.
- Do not change storage bucket names or environment variable names without explicit approval.

## Quality Requirements

Preserve the following:

- OCR must not fabricate unreadable text.
- Article structuring must not create facts not present in the image/OCR context.
- OpenAI quota or API failures must not be hidden as article content.
- Upload failures must leave recoverable failure state where possible.
- Article listing must not regress to fixed 270/300 item behavior.
- Full analysis must not regress to a hidden 160 article cap.
- Monthly rollups must support stale detection and stale-only regeneration.
- Reports must include evidence links, refutation, evidence grading, and research needs.

## Required Commands

Run from the app root:

```bash
npm run lint
npm run build
npm run test:local
```

If a command cannot run because of local environment issues, report the exact reason and do not claim it passed.

This file must remain consistent with `AGENTS.md`.


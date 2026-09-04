# CLAUDE.md

## Current Production Rule — Read First

MJ Insight Vault has moved to a Google Drive + Neon canonical architecture.

Use:

- repository `hgwd89/mj-insight-vault`
- app root `mj-insight-vault-mvp/mj-insight-vault`
- canonical Vercel project `hgwd89-mj-insight-vault-k5k2`
- Google Drive `01 Originals` for original files
- Neon project `round-glitter-99489346` for article/source metadata and searchable text
- `/cloud-stock` as the canonical article browsing/search UI

## Supabase Is Retired

Do **not** follow older repository instructions that name Supabase project `wqbjtvepnavkqdshppau` as the authoritative database. Those instructions are superseded as of 2026-09-04.

Do not:

- reconnect production features to Supabase;
- use Supabase as a fallback when Neon data is missing;
- wait for Supabase service recovery;
- call legacy Supabase article/search/storage/report APIs to make the current application work;
- restart the old 540-page historical completion mission merely because its runbook still exists;
- claim old articles are available unless they exist in Neon or have been imported from a verified non-Supabase archive.

`docs/MJ_CURRENT_FREEZE_COMPLETION_RUNBOOK.md` is a historical handoff document for the retired Supabase architecture. It is not the current production runbook.

## Current Responsibility Boundaries

- Article list/search: `components/NeonArticleVault.tsx` + `app/api/cloud-stock/articles/route.ts`
- Article detail: `components/NeonArticleDetail.tsx` + `app/api/cloud-stock/articles/[id]/route.ts`
- Original preview: `app/api/cloud-stock/files/[id]/content/route.ts` + Google Drive
- Readiness: `app/api/cloud-stock/readiness/route.ts`
- Neon access: `lib/neonCloud.ts`
- Google Drive read: `lib/googleDriveRead.ts`
- Google Drive write/probe: `lib/googleDriveBackup.ts`

Legacy `/articles` and `/api/articles*` are retired compatibility paths and must not become active Supabase paths again.

## Historical Data Rule

The historical Supabase corpus is not considered recovered merely because legacy schema/code remains in GitHub.

Before claiming past articles can be searched, prove that their records exist in Neon or in a verified non-Supabase backup/export and have been migrated. If no such copy can be found, state that the historical records are currently unavailable rather than silently querying Supabase.

## Operational Safety

During recovery or architecture maintenance, do not initiate OCR, Classification, Theme Analysis, Report generation, or bulk corpus processing unless explicitly requested.

Do not delete production originals or database rows as part of recovery work.

## Required Commands

Run from the app root:

```bash
npm run lint
npm run build
npm run test:local
```

Do not weaken tests to obtain a green result. If a test encodes the retired Supabase architecture, update the test to the current Google Drive + Neon contract only when the production architecture has genuinely changed accordingly.

This file must remain consistent with `AGENTS.md`.

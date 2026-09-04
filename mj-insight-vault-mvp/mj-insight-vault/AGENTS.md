# AGENTS.md

## Current Canonical Architecture — 2026-09-04

MJ Insight Vault is a Next.js application for preserving Nikkei MJ originals and searchable article text.

The only active production data path is:

- GitHub repository: `hgwd89/mj-insight-vault`
- Canonical Vercel project: `hgwd89-mj-insight-vault-k5k2`
- Originals: Google Drive `01 Originals`
- Structured/searchable data: Neon project `round-glitter-99489346`
- Article UI: `/cloud-stock`
- Article APIs: `/api/cloud-stock/articles` and `/api/cloud-stock/articles/[id]`

## Supabase Is Retired — Non-Negotiable

Supabase project `wqbjtvepnavkqdshppau` is retired from MJ Insight Vault runtime and is **not** an authoritative source anymore.

Never:

- reconnect active UI or APIs to Supabase;
- wait for Supabase recovery before making the app usable;
- treat `ACTIVE_HEALTHY` as a reason to restore Supabase dependencies;
- read or write Supabase as a fallback for article search, originals, Inventory, reports, or any other product function;
- revive `/api/articles`, legacy signed URLs, Supabase Storage, or legacy Supabase database routes as an active path;
- claim historical Supabase data has been recovered unless a verified non-Supabase copy has actually been imported into Neon/Drive.

Legacy Supabase code, migrations, tests, and historical runbooks may remain in the repository as archaeology only. They do not define current production architecture.

## App Root

Always use:

```text
mj-insight-vault-mvp/mj-insight-vault
```

Run npm commands from this directory.

## Current Data Responsibilities

- Google Drive: original files and durable file identity.
- Neon `vault_source_files`: original metadata and Drive linkage.
- Neon `vault_articles`: searchable article text linked to `vault_source_files`.
- Article detail must preserve the link back to the Google Drive original and allow in-app original preview where supported.
- Historical articles are searchable only if their data exists in Neon or another verified non-Supabase archive that has been explicitly migrated into Neon.

Do not fabricate missing historical corpus. If no non-Supabase copy exists, report that fact plainly.

## Operational Safety

During recovery/maintenance work, do not start OCR, Classification, Theme Analysis, Report generation, or bulk corpus processing unless the user explicitly requests that processing.

Never delete production originals or data merely to complete a migration. Prefer additive, verified changes.

## Important Active Files

- `components/NeonArticleVault.tsx`: article list/search UI.
- `components/NeonArticleDetail.tsx`: article detail and linked-original preview.
- `app/api/cloud-stock/articles/route.ts`: Neon article search/list.
- `app/api/cloud-stock/articles/[id]/route.ts`: Neon article detail.
- `app/api/cloud-stock/files/[id]/content/route.ts`: authenticated Google Drive original streaming.
- `app/api/cloud-stock/readiness/route.ts`: Drive read/write capability + Neon readiness.
- `lib/neonCloud.ts`: Neon Data API/auth configuration.
- `lib/googleDriveRead.ts`: Google Drive reads.
- `lib/googleDriveBackup.ts`: Google Drive write capability/upload helpers.

## Required Verification

Run from the app root:

```bash
npm run lint
npm run build
npm run test:local
```

Default CI/local tests must not make external production writes.

A change is complete only when relevant source has been checked, lint/build/local tests pass (or an exact pre-existing tooling failure is reported), Preview/Production state is verified where applicable, and no test is weakened merely to pass.

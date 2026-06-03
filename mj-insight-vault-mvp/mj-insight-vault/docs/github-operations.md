# GitHub Operations

## Scope

This document covers GitHub-side operations for `hgwd89/mj-insight-vault`.

The app root is:

```text
mj-insight-vault-mvp/mj-insight-vault
```

All npm commands in GitHub Actions must set this directory as the working directory.

## Branch Protection

Configure branch protection manually in GitHub for `main`.

Recommended settings:

- Require a pull request before merging.
- Require status checks to pass before merging.
- Require branches to be up to date before merging when practical.
- Restrict force pushes.
- Restrict deletions.
- Require review for changes touching high-risk areas when the team workflow supports it.

Recommended required checks:

- `lint`
- `build`
- `test-local`

These checks are emitted by the root workflow `.github/workflows/mj-local-ci.yml` (`MJ Local CI`). The workflow runs from `mj-insight-vault-mvp/mj-insight-vault` and uses:

- `npm ci`
- `npm run lint`
- `npm run build`
- `npm run test:local`

These checks run without Google Vision, OpenAI, or Supabase production access. Keep those required check names aligned with the workflow job names.

## Required Check Policy

Normal pull request checks must not call:

- Google Vision OCR
- OpenAI Responses, Chat Completions, or embeddings
- Supabase production database
- Supabase production storage
- Vercel deployment APIs

External API checks belong in explicit manual verification, not default PR CI.

## Secrets

Do not add these secrets to ordinary PR workflows:

- `GOOGLE_CLOUD_CREDENTIALS`
- `OPENAI_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- production Supabase storage credentials

If a future workflow needs secrets, make it manual (`workflow_dispatch`) and document:

- why the external API is needed
- which environment it targets
- how production data mutation is prevented
- what logs may contain

Never echo secret values in logs.

## Supabase Safety

Default CI must not read, write, update, or delete production Supabase data.

Migration changes require separate review. Do not apply migrations from PR CI unless there is an explicit migration workflow and environment approval gate.

## Self-hosted Runner Policy

Self-hosted runners may have local credentials or cached data. If used:

- do not run untrusted fork PRs on a credentialed runner
- do not mount directories containing `.env` files into jobs
- clear workspace artifacts after jobs
- keep external API checks separated from default PR checks

## Artifact Policy

For default PR checks, artifacts are usually not needed.

If artifacts are added later, avoid uploading:

- `.env`
- Supabase credentials
- Google service account JSON
- OCR image files containing private data
- generated reports that may include confidential article content

## Manual Verification After CI

After `build`, `lint`, and `test-local` pass, manual checks may cover:

- upload draft restore
- OCR with a safe test image
- source image reprocess
- monthly rollup generation
- stale-only regeneration
- chat report generation
- report evidence links

Mark any unverified external API behavior explicitly in PR notes.

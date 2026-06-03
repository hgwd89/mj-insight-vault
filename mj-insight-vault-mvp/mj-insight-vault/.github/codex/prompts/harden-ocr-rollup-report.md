# Codex Harden OCR Rollup Report Prompt

Harden MJ Insight Vault without broad rewrites.

App root:

```text
mj-insight-vault-mvp/mj-insight-vault
```

Read these files before editing:

- `components/UploadFormStable.tsx`
- `lib/uploadDraftStore.ts`
- `lib/vision.ts`
- `lib/articleSegmentation.ts`
- `app/api/source-images/[id]/process/route.ts`
- `app/api/source-images/[id]/reprocess/route.ts`
- `lib/monthlyRollups.ts`
- `lib/monthlyRollupContext.ts`
- `lib/chatRouteNo160.ts`
- `app/api/chat/jobs/[id]/run/route.ts`
- `lib/reportPrompt.ts`
- `lib/chatAnalysisQualityGate.ts`

Hardening priorities:

- Do not fabricate unreadable OCR content.
- Do not turn API errors into article text.
- Preserve raw OCR vs structured article boundary.
- Keep failed upload files recoverable.
- Preserve stale rollup marking after article creation/reprocess.
- Preserve stale-only regeneration.
- Do not reintroduce fixed 270/300 listing caps.
- Do not reintroduce hidden 160 analysis caps.
- Keep reports evidence-linked and refutation-aware.

Verification:

```bash
npm run lint
npm run build
npm run test:local
```

Do not change DB schema, storage bucket names, environment variable names, or production data mutation behavior unless explicitly requested.


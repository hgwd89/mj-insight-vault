# Legacy Supabase import redeploy receipt

Purpose: one-time Git-triggered redeploy attempt for the read-only, idempotent Supabase Storage -> Google Drive migration path after Vercel Hobby build-rate limiting.

Safety invariants:
- Supabase source objects are retained; no deletes.
- OCR, classification, reports, and 538-item rollout remain disabled.
- Google Drive is the original-file destination; Neon is the structured index.
- Duplicate Drive uploads are prevented by deterministic legacy file naming and lookup.

Validated code baseline before this receipt: f7971d9b97cba907fbf1a144d594fcf750f115bd (lint/build/test-local passed).

# MJ Insight Vault — Current Historical Freeze Completion Runbook

Last handoff checkpoint: 2026-08-21 JST

This document is the canonical repository handoff for completing the current MJ Insight Vault historical freeze. **Do not treat the numeric checkpoint below as permanently current. Always fetch fresh authoritative state before doing any work.**

## 0. Mission / final goal

Finish the current historical freeze **end-to-end**, not merely the Article Inventory step.

The work is complete only when all of the following are true on the same authoritative current freeze:

1. Article Inventory has **540/540 legitimate terminal page states** and `source_page_article_inventory_gate_v2.inventory_gate = 'passed'`.
2. OCR verification has passed for the authoritative corpus.
3. Classification is complete.
4. Full Article Review is complete.
5. Theme Candidate generation is complete.
6. Full Census is complete.
7. Theme Analysis is complete.
8. A formal report is successfully generated and saved.
9. The formal report is accessible in canonical Vercel Production.
10. Article/evidence links in the report actually work.
11. Production health/readiness is verified.
12. No unresolved blocker prevents normal use.

Do **not** declare completion by rewriting status flags. Completion must be backed by the actual production gates, receipts, exact-set checks, grounding/mapping checks, and saved report artifacts.

---

## 1. Authoritative systems — non-negotiable

### Supabase

Use only:

- Project ID: `wqbjtvepnavkqdshppau`
- Project: hgwd89's Project

**Never use `umecmthqvvdcmwqfhgqf`.** It is not the authoritative connected production project for this task.

### Repository

- GitHub: `hgwd89/mj-insight-vault`
- App root: `mj-insight-vault-mvp/mj-insight-vault`

### Canonical Vercel project

- Project: `hgwd89-mj-insight-vault-k5k2`
- Team: `DAISUKE HAGAWA's projects`

At this handoff checkpoint, GitHub `main` and canonical Production both pointed to:

- commit `7f5abc8810d290a42e025394f403826f958a7f32`
- Vercel Production state: `READY`

Re-fetch before relying on these values.

---

## 2. Latest authoritative checkpoint at handoff

Current freeze at the last fresh read:

- freeze receipt: `17fb63ab-5fe7-4d18-824d-3cbd75f5fbcd`
- total pages/jobs: `540`
- completed: `184`
- queued: `177`
- needs_review: `179`
- failed: `0`
- discovery_required: `0`
- Inventory gate: `failed`
- gate reason: `recovered_inventory_review_required`
- OCR recovery completed pages: `540`
- orphan visual evidence: `0`
- Inventory execution: `enabled = false`
- grounded third pass execution: `false`

Therefore the handoff checkpoint had **356 remaining non-completed pages**.

Again: this is only a checkpoint. If the freeze ID changes, mark these counts superseded and establish a new baseline from the new current freeze.

---

## 3. Mandatory first step on every run

Before changing anything, fetch fresh production state from `wqbjtvepnavkqdshppau` and record:

- current `freeze_receipt_id` from `formal_corpus_freeze_gate_v2`
- status counts from `source_page_article_inventory_jobs_v1` scoped to that current freeze
- `source_page_article_inventory_gate_v2`
- `inventory_v3_execution_control_v1`
- OCR recovery gate/counts
- orphan visual evidence count
- stale/running lease anomalies if any
- GitHub `main` SHA
- canonical Vercel Production deployment SHA and readiness

Do not revive counts from older freeze generations.

If current freeze changes, explicitly reset the baseline to the new freeze.

---

# PHASE 1 — Finish the historical 540-page Article Inventory

## 4. Phase 1 OpenAI restriction

While Article Inventory is incomplete:

- keep production Inventory execution disabled
- keep grounded third-pass execution disabled
- make **no new OpenAI API calls for historical Inventory review**

Allowed evidence only:

- existing OCR
- existing GPT-4.1 receipts
- existing GPT-4o receipts
- existing GPT-5.6-sol receipts
- current-freeze formal corpus
- page identity/current capture information
- deterministic logic
- manual Claude/ChatGPT adjudication using already stored evidence

Preserve original receipts and proof lineage.

The fact that an RPC temporarily sets execution flags inside a single uncommitted transaction for `claim/finalize` is acceptable only when the transaction restores `enabled=false` and `grounded_third_pass_enabled=false` before commit and no external API is invoked. This pattern is already used by existing offline finalize RPCs.

---

## 5. Safety rules — never weaken these to gain progress

Never:

- lower structural confidence gates
- lower grounding gates
- lower mapping confidence/margin gates
- force a genuine discovery into an existing formal article
- use a generic Inventory drain
- fabricate consensus or mapping
- delete/overwrite original pass receipts to make partitions agree
- rewrite completed/status flags without proof
- accept partial mappings as completed
- leave rejected safety-gate transactions partially committed
- repeatedly retry the same known failing path without new information

If one page is blocked, leave it safely blocked and continue other pages.

Prefer targeted exact-job execution and existing SECURITY DEFINER RPC contracts over ad hoc DML.

---

## 6. What has already worked safely

The following categories have already produced legitimate completions without new OpenAI API calls. Reuse these patterns when current schema/state still supports them.

### A. Strict historical completed-proof reuse

Existing exact historical completed reuse paths were used successfully when source and target identity/proof were exact and current structural guards passed.

Do not assume the path still has candidates; query first.

### B. Exact historical mapper/critic/adjudicator reuse

Existing GPT pass receipts were reused only when exact page/OCR identity and lineage matched. Do not copy approximate historical results.

### C. Existing visual consensus -> automatic mapping -> finalize

When visual consensus already exists and current strict mapping resolves the complete formal set, finalize normally.

### D. Partial mapping -> exact literal semantic mapping

`apply_inventory_offline_partial_semantic_mapping_v1(...)` has been used safely when:

- visual consensus exists
- the candidate group/article are the only intended unmatched pair or a verified unmatched pair
- a literal shared anchor of sufficient length occurs in both consensus group text and formal headline
- the page/formal article identity is exact
- grounding violations remain zero

Then finalize through the existing offline finalize path.

### E. Partial mapping -> clean-body-grounded mapping

The last three queued consensus pages at this handoff were completed using the existing clean-body contract after converting only the targeted job to `needs_review` transaction-locally.

Relevant RPC:

- `apply_inventory_body_grounded_mapping_v2(job_id, group_fingerprint, article_id, reason)`

Its existing thresholds include:

- `clean_body_similarity >= 0.05`
- `clean_body_similarity_margin >= 0.04`
- exactly one unresolved group and one unresolved formal article

Do not change these thresholds.

The three successfully completed jobs immediately before this handoff were:

- `3182704e-a383-433f-a310-6996e264bddb`
- `7956f94e-b67c-471c-a53d-3b147c18ea26`
- `9cbc8c5c-124f-47b2-a6b9-4e5be2cc8a12`

All finalized with `api_calls = 0` and `grounding_violations = []`.

### F. Multi-unresolved reciprocal body grounding

There is an existing stricter RPC:

- `apply_inventory_reciprocal_body_grounded_mapping_v1(...)`

It requires balanced multiple unresolved groups/articles and reciprocal margins. Use only when its built-in guards pass. Do not weaken them.

### G. Page-wide strong-body bijection

Existing RPC:

- `recover_inventory_v7_strong_body_bijection_v1(limit)`

At the handoff checkpoint it returned `attempted=0`, so do not spin on it unless fresh state creates eligible candidates.

### H. Strict blind-review resolvers

Existing strict resolvers have been used for:

- unique overlap
- formal-body merge
- hard non-article exclusion
- ambiguous correspondence
- unique formal mapping

Use each only for pages satisfying its own contract. Rejected calls must remain rolled back.

---

## 7. Main residual Phase 1 problem classes at handoff

Immediately before the latest three completions, the major `needs_review` classes included approximately:

- `blind inventory v3: no two complete partitions agree` — dominant class (roughly 133 at the prior checkpoint)
- `One-model-only visual article has no independent support.` — about 20
- historical majority-N unresolved singleton cases
- mapping review cases
- ambiguous article correspondence cases
- several three-way visual ties
- one supported-article/no-majority-block case

Re-query counts; do not rely on these approximate numbers.

For the dominant blind three-pass disagreement class, simple historical exact reuse and the obvious strict bulk resolvers were largely exhausted. These pages may require page-by-page adjudication using stored OCR + stored mapper/critic/adjudicator group partitions + formal article text.

A legitimate manual adjudication must still be recorded through an existing proof/receipt RPC or a minimal, auditable root-cause implementation if no appropriate RPC exists. Do not simply edit rows to match the decision.

---

## 8. Recommended Phase 1 processing order

Repeat until no safe candidates remain, then move to manual adjudication classes.

1. Fresh current-freeze state.
2. Finish any existing visual-consensus pages with partial mapping.
3. Exact completed-proof reuse candidates.
4. Exact historical mapper/critic/adjudicator reuse candidates.
5. Exact consensus/current formal mapping candidates.
6. Strict semantic/body-grounded mapping candidates.
7. Strict ambiguous/overlap/formal-body/hard-exclusion resolver candidates.
8. Majority-N/tie-specific existing contracts.
9. Manual deterministic adjudication of remaining blind disagreement pages, one page at a time, while preserving all original three-pass receipts.
10. Genuine new-article discovery/recovery only when the evidence truly shows the current formal corpus is missing an article.
11. Recheck gate/count/OCR/orphans after every meaningful batch.

Do not stop merely because one resolver class is exhausted.

---

## 9. Genuine new-article cases

If stored evidence shows a real article is missing from the current formal corpus:

- do not force-map it to an existing article
- use the formal discovery/recovery/refreeze workflow
- preserve the prior formal corpus/provenance
- justify the new article with grounded page evidence
- ensure the new freeze/current formal set is internally consistent
- after a refreeze, reset all progress reporting to the new current freeze and treat old counts as superseded

Discovery should be rare and evidence-driven.

---

## 10. Phase 1 completion gate

Phase 1 is complete only when:

- all 540 current-freeze pages are in legitimate terminal states required by the production gate
- `failed = 0` unless the product contract explicitly permits a legitimate terminal exception and the gate still passes
- no unresolved discovery is pending
- `source_page_article_inventory_gate_v2.inventory_gate = 'passed'`
- OCR current set is healthy
- orphan evidence remains 0
- execution control remains safe
- completed proof/invariants pass

Do not start Phase 2 merely because `completed` is numerically high.

---

# PHASE 2 — Formal downstream pipeline

Only after Inventory gate passes, proceed in this order on the same authoritative freeze:

1. OCR Verification
2. Classification
3. Full Article Review
4. Theme Candidate
5. Full Census
6. Theme Analysis
7. Report

At this point the special historical Inventory restriction on new OpenAI calls is lifted. Use the intended production API pipeline where required, but reuse already-valid outputs/receipts rather than reprocessing unnecessarily.

For every stage:

- use current authoritative DB state
- use targeted exact jobs/routes where available
- respect idempotency
- preserve exact-set/materialization/provenance/security gates
- do not fake completion flags
- reuse valid prior completed outputs when their input fingerprint/current freeze requirements still match

---

## 11. Implementation / DB defects

If a real implementation, database contract, or configuration defect blocks progress:

1. prove the root cause from current production state/code
2. make the smallest change that fixes the root cause
3. add regression proof/test where appropriate
4. do not weaken safety gates to pass
5. run from app root:

```bash
npm run lint
npm run build
npm run test:local
```

6. use Preview/CI as appropriate
7. merge/deploy only after the change itself is proven
8. verify canonical Production again

Do not make retry-only commits to bypass Vercel limits.

If Vercel quota/rate limits block deployment, continue independent safe DB/adjudication work and retry deployment later.

---

## 12. Production verification

Canonical Production must ultimately be verified for:

- deployment `READY`
- deployment commit matches intended GitHub main
- no relevant runtime errors
- report page is reachable
- saved report loads from production data
- article/evidence links function
- normal report use is not blocked by auth/config/runtime/schema errors

At the handoff checkpoint, Production and GitHub main matched `7f5abc8810d290a42e025394f403826f958a7f32`, but this must be rechecked at completion.

---

## 13. Reporting discipline

Use fresh authoritative values only.

For each checkpoint report:

- current freeze ID
- completed / queued / needs_review / failed / discovery_required
- Inventory gate + reason
- delta from immediately previous checkpoint on the **same freeze**
- OCR recovery/readiness
- orphan evidence count
- execution control state
- material work completed in that run
- actual blocker, if any

If the freeze changes, explicitly state that the previous counts are superseded.

Do not create parallel contradictory progress summaries.

---

## 14. Final completion report

When the entire task is done, report at minimum:

- final authoritative freeze ID
- Inventory final counts (`540/540` legitimate terminal state)
- Inventory gate state
- OCR verification gate state
- Classification state/count
- Full Article Review state/count
- Theme Candidate state/count
- Full Census state/count
- Theme Analysis state/count
- formal report identifier
- canonical Production report location
- evidence/article-link verification result
- Production deployment SHA/readiness
- runtime-health result
- any legitimate documented exceptions

Only then is this runbook's mission complete.

---

## 15. Short instruction for Claude Code

**Continue until the final goal in section 0 is actually satisfied. Do not stop at partial progress, do not ask for confirmation between safe steps, and do not substitute status rewrites for real proof-backed completion. During Phase 1, keep historical Inventory OpenAI execution disabled and use only already-existing evidence plus deterministic/manual adjudication. When one page is blocked, continue other safe pages. Always re-fetch the current freeze and production state before acting.**

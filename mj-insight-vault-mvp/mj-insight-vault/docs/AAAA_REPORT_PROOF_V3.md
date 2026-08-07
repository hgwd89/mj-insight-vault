# AAAA Report Proof v3

## Why v2 is not sufficient

The current v2 pipeline can prove that every formal article ID was assigned to a completed scan batch, but it cannot prove that the model substantively read every article or that the final themes are representative of the corpus.

Confirmed production defects on run `e036a34d-65b0-48cd-a0ac-3b25f06dbfcb` / report `bed28473-2bfe-4075-9bbe-430b468984c4`:

1. `read_article_ids` is canonicalized to server-supplied batch IDs and therefore cannot be used as model-reading proof.
2. Model-reported IDs are incomplete and contaminated by IDs not belonging to the batch.
3. Persisted `evidence_article_ids` is inflated by fallback IDs that are not present in `summary_json.evidence`.
4. The final full-corpus digest keeps only the first observation, first contradiction, first research need, and one evidence item per batch.
5. Evidence candidate selection caps the global pool and can exclude later batches.
6. Final evidence selection is not constrained to each theme's declared `supporting_batch_indices`.
7. The DB semantic gate recognizes writer path v1 while the live writer emits v2, so v2 bypasses that semantic check.
8. Formal eligibility checks final evidence shape but does not recompute theme prevalence, article support counts, counterevidence counts, or support-batch consistency from the corpus.

## v3 invariant

A report is never formal because an LLM says it read all articles. Formality requires database-recomputable proof.

### Stage A — per-article reading receipts

Every formal article in the scan run must have exactly one persisted receipt:

- `run_id`
- `batch_id`
- `article_id`
- `article_analysis_sha256`
- `grounded_excerpt`: a verbatim excerpt from the stored article analysis text
- `observed_fact`: a short fact derived from that excerpt
- `signal_class`: `direct_consumer`, `market_signal_only`, or `no_consumer_signal`
- `consumer_relevance`: `high`, `medium`, `low`, or `none`
- `confidence`
- model/prompt metadata

The DB must recompute that:

- receipt article IDs exactly equal the run's article IDs;
- no duplicate receipts exist;
- the article hash still matches the scanned text version;
- `grounded_excerpt` is actually present in the article text;
- every completed batch has receipts for all and only its articles.

No receipt means no completed batch. No completed batch means no formal report.

### Stage B — candidate theme discovery

Theme discovery is exploratory only. It may use compressed batch summaries to propose candidate themes, but these themes are not yet considered representative.

Discovery output must contain 6–10 candidate themes with neutral wording and explicit falsification conditions.

### Stage C — full-corpus theme census

Every article receipt is evaluated against every candidate theme and assigned one relation:

- `support`
- `counter`
- `related_not_supporting`
- `none`

For support/counter rows, persist a grounded article ID and evidence type. This creates a census matrix over the full corpus.

Final theme ranking is deterministic from the census, not chosen by the Writer. Required metrics include:

- supporting article count
- supporting batch count
- direct-consumer supporting count
- counterevidence article count
- support share of the full corpus
- batch spread
- month/time spread where dates are parseable
- supply-only share

A theme cannot be promoted as a major consumer narrative solely because it has a few striking articles.

### Stage D — deterministic evidence selection

Evidence must be selected only from census `support` rows for that theme. Counterevidence must be selected only from census `counter` rows.

Selection is stratified by:

- distinct batches
- distinct time periods where possible
- evidence type
- direct-consumer vs supply-side

The Writer cannot introduce an article outside the selected and DB-validated evidence set.

### Stage E — Writer and Critic

The Writer receives:

- ranked themes and recomputed metrics
- selected support evidence
- selected counterevidence
- negative-space metrics
- research needs

The Writer must distinguish observed fact, corpus-level inference, and hypothesis.

The Critic must reject:

- causal claims unsupported by evidence
- claims stronger than census metrics
- evidence assigned to the wrong theme
- supply-side activity presented as consumer demand
- unsupported psychological inference
- generic implications not derived from the evidence

### Stage F — formal DB gate

A v3 formal report requires all of the following:

1. `full_corpus_batch_v3`
2. exact receipt coverage for every formal article
3. zero ungrounded receipts
4. census coverage for every receipt against every candidate theme
5. deterministic final theme ranking metrics
6. each final theme has minimum support breadth and at least two independent evidence articles
7. final evidence belongs to the theme's support census
8. counterevidence belongs to the theme's counter census
9. Writer path `full_corpus_receipt_census_writer_v3`
10. formal gate `formal_gate_v4` / `receipt_census_grounded_v1`
11. semantic critic passed
12. no fallback, no provisional state, no external unverifiable evidence

## Presentation requirements

The report must expose, for each major theme:

- supporting articles / full corpus
- supporting batches / total batches
- direct-consumer evidence count
- counterevidence count
- confidence grade
- at least two representative source articles
- at least one limiting/counter reading where available

The UI must never display `本文読解記事: N` from assignment counts. It must display `読解レシート検証済み: N/N` computed from receipt rows.

## Migration rule

v1/v2 scan runs and v1/v2 hierarchical writer outputs remain historical records but cannot be newly certified as v3 formal reports. Existing formal rows produced by a bypassed semantic gate must be re-audited and demoted if they do not satisfy v3 proof.

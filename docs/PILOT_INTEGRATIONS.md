# Phase 3 pilot integrations (RAM-04)

Software interfaces for the pilot. None of them authorizes real animal movement or money movement by itself; the Phase 0 decisions (docs/PHASE0_DECISION_REGISTER.md) and the accountable pilot gates (`/ops/pilot`) remain required.

## Producer data feeds
- Supplier systems submit batches to `POST /api/farm/batch/import` as the JSON envelope `{batchKey, rows:[{externalAnimalId, submission}]}` or as a herd-management **CSV export** (`Content-Type: text/csv`, `?batchKey=...`). Columns: `externalAnimalId` plus the single-submission fields (`species, breed, sex, ageMonths, weightKg, condition, diseaseStage, observedSigns, firstObservedDate, existingDiagnosis, currentTreatment, generalHusbandry, cullDecisionDate, plannedCullAt, cullReason, welfareUrgency, independentCullAttestation, ownerAttestation`). Unknown/duplicate columns, ragged rows and bad quoting are rejected.
- Authentication: browser session or an organization API key (`Authorization: Bearer ramk_...`, see docs/RULE_PUBLICATION_AND_API_KEYS.md).
- Every row is validated exactly like a single submission (attestations must be explicit); the batch is stored in **quarantine**, idempotent by `batchKey` (reuse with different content is rejected).
- RAM operations verify and **promote** or **reject** at `/ops/producer-feeds` (compare-and-swap; a batch can be reviewed once; supplier cannot self-promote). Promotion creates `SUBMITTED` animal cases that still need veterinary pre-screen.

## Diagnostic laboratory integration
- `POST /api/diagnostics/webhook`, signed with `RAM_DIAGNOSTICS_WEBHOOK_SECRET` (HMAC-SHA256 over `"<unix seconds>.<raw body>"`, ±300 s), provider name `RAM_DIAGNOSTICS_PROVIDER_NAME`. Returns 503 until configured.
- Strict report schema (test code/name, result status, interpretation, observations, `reportable`). Idempotent on `(provider, externalReportId)`; the same id with different content is a 409 (send a CORRECTED report with a new id).
- Reports attach to the animal case with a review flag (`REPORTABLE_CONDITION_STOP`, `VET_REVIEW_REQUIRED`, `INFORMATIONAL`, `CANCELLED`). They **never** change case status. Veterinarians see and acknowledge them on `/vet/<case>`.
- A lab that cannot sign requests directly needs a small integration gateway that signs on its behalf (owner to-do: pick a lab/LIMS).

## Transport corridors
- Transport assignment records origin/destination state codes and the corridor decision from **published** compliance rules (deny by default; a matching prohibition wins).
- `RAM_CORRIDOR_RULES_ENFORCED=true` makes the decision blocking (required by the pilot-readiness check `corridor_rules_enforced`). In the demo it is off and the decision is only recorded.

## Payment reconciliation
- `/finance/reconciliation` (or `POST /api/finance/reconciliation`) takes a provider statement for a period and compares it with RAM payment executions submitted in that period: amount, currency and status mismatches, executions missing at the provider, provider lines unknown to RAM and duplicate lines. Runs are persisted, audited and idempotent per identical statement.
- With the Stripe adapter configured, statements can be exported from Stripe; with the provider-neutral gateway, from that provider's report.

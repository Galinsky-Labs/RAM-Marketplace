# Versioned rule publication and enterprise API keys (RAM-05)

## Compliance rule publication
- Drafts (`/ops/compliance/rules`) are append-only revisions with a content digest (compare-and-swap on save).
- Publishing (`POST /api/ops/compliance/rules/publications` with `{ruleId, revision, digest}`) requires a RAM compliance or super-admin principal **who is not the revision author** (two-person rule), an exact digest match, and an unaltered payload. Publishing supersedes the previous publication of that rule atomically and writes an audit event. An older revision cannot replace a newer one.
- Corridor decisions (`lib/compliance-rules.ts#evaluateCorridor`, server `decideCorridor`) are **deny-by-default**: a matching in-effect published prohibition always wins; otherwise a matching in-effect published permit is required. Decisions carry the exact `ruleId`, `revision` and `digest` used.
- Publishing a rule in software is not legal or veterinary approval. Real corridors still require the Phase 0 decisions (P0-01, P0-05) to be recorded by accountable humans.

## Enterprise API keys
- Supplier organization administrators create keys at `/farm/api-keys` (or `POST /api/farm/api-keys`). Keys look like `ramk_<prefix>_<secret>`; only a SHA-256 hash is stored and the plaintext is shown once.
- Scopes: `supplier-batch:write`, `supplier-batch:read`. Lifetime 1–365 days (default 90); max 10 active keys per organization.
- A key acts as its creating member: the membership and organization status are re-checked on every request, so suspension/revocation disables the key immediately. Keys can be revoked (`DELETE /api/farm/api-keys?id=`).
- `POST/GET /api/farm/batch/import` accept `Authorization: Bearer ramk_...`. Bearer-key requests are exempt from the browser same-origin check (no cookie is used); a request with a key header never falls back to the cookie session.
- Keys never grant RAM staff, compliance, finance or admin capabilities and cannot publish, price or move animals; batches land in quarantine.

Standards-based enterprise SSO (OIDC) is provided by the identity adapter (`docs/IDENTITY_OIDC.md`).

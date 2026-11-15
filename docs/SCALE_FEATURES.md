# RAM-05 scale features: procurement, multi-state activation, second species

## Institutional procurement (`/research/procurement`, `POST /api/research/procurement`)
- Buyer organizations set a policy (RESEARCH_PROCUREMENT): `requirePurchaseOrder` and a single-approver limit.
- A research PI or procurement user requests a PO (PO number, cost center) for a quoted order in `CHECKOUT_PENDING`; the PO amount is fixed to the quoted buyer price. PO numbers are unique per organization.
- Approval: RESEARCH_PROCUREMENT only; the requester can never approve; amounts above the limit need a second, different approver (`PARTIALLY_APPROVED` → `APPROVED`). Rejections need a note and allow a new request. All transitions are compare-and-swap and audited.
- When the policy requires a PO, buyer commitment is refused until an `APPROVED` PO matches the quoted amount exactly. Without a policy the existing flow is unchanged.

## Multi-state activation (`/ops/compliance/jurisdictions`)
- One `(state, species)` at a time: a RAM compliance reviewer proposes with an evidence reference; a different reviewer approves (`ACTIVE`); any reviewer can suspend immediately with a reason (`SUSPENDED`, re-proposable). Audited.
- Corridor decisions (`decideCorridor`) now require a published permitting rule **and** both corridor states `ACTIVE` for the species. With `RAM_CORRIDOR_RULES_ENFORCED=true` this blocks transport assignment.
- Activation is software control only; it does not replace the P0-01/P0-05 legal and veterinary decisions it must reference.

## Second-species groundwork (`lib/species.ts`)
- Species catalog: Swine (`PILOT`), Bovine (`GROUNDWORK`). Known species are normalized (case) and given profile plausibility limits (age, weight) at submission; IDs use the catalog code (`RAM-SW-…`, `RAM-BV-…`).
- Groundwork species can be submitted, reviewed and matched in software but cannot be jurisdiction-activated, so they cannot move under corridor enforcement. Promoting Bovine to `PILOT` is a reviewed code change requiring species-specific transport, disease-movement and veterinary protocols.

Tests: `tests/scale-readiness.test.ts`; live: `npm run e2e:scale` (CI).
